import { and, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { IMAGE_UPLOAD_LIMITS, type CoverSpec, type TopicToDraftRequest } from "@v2media/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { collectedNotes, collectionAnalyses, drafts, jobs, topics } from "../db/schema";
import { generateDraft, type DraftSource } from "./draft-gen";
import { automaticCoverSpec } from "./cover-spec";
import { queueCover, runCoverJobs } from "./cover-jobs";

interface Payload { draftId: number; revision: number; textVersion: number; source: DraftSource; referenceKind: string; base: string }

export async function createTopicDraft(deps: Deps, userId: number, id: number, opts: TopicToDraftRequest, base: string) {
  return deps.db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM topics WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
    const [topic] = await tx.select().from(topics).where(and(eq(topics.id, id), eq(topics.userId, userId)));
    if (!topic) return { error: "选题不存在", code: 404 as const };
    if (topic.draftId) {
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, topic.draftId), eq(drafts.userId, userId)));
      if (draft) return { draft, topic, code: 200 as const };
    }
    if (opts.ai && !deps.r2) return { error: "自动成稿需要 R2 图片存储，请配置后再生成", code: 503 as const };
    const [note] = topic.sourceNoteId ? await tx.select().from(collectedNotes)
      .where(and(eq(collectedNotes.id, topic.sourceNoteId), eq(collectedNotes.userId, userId))) : [];
    const [draft] = await tx.insert(drafts).values({
      userId, collectedNoteId: topic.sourceNoteId,
      title: topic.title, content: opts.ai ? "" : topic.angle || topic.title,
      tags: opts.ai ? [] : note?.tags ?? [], images: opts.ai ? [] : note?.images.map(i => ({ url: i.url })) ?? [],
      ...(opts.ai ? { generationState: "queued", generationRevision: 1 } : {}),
    }).returning();
    const [updatedTopic] = await tx.update(topics).set({ status: "drafted", draftId: draft!.id, updatedAt: deps.now() })
      .where(eq(topics.id, topic.id)).returning();
    if (!opts.ai) return { draft: draft!, topic: updatedTopic!, code: 201 as const };
    const collectionId = topic.collectionId ?? note?.collectionId;
    const [analysis] = collectionId ? await tx.select({ data: collectionAnalyses.data }).from(collectionAnalyses)
      .where(and(eq(collectionAnalyses.collectionId, collectionId), eq(collectionAnalyses.userId, userId), eq(collectionAnalyses.status, "done")))
      .orderBy(desc(collectionAnalyses.id)).limit(1) : [];
    const visuals = analysis?.data.visual ?? [];
    const referenceKind = (visuals.find(v => v.id === topic.sourceNoteId) ?? visuals.find(v => v.hit))?.kind ?? "";
    const [hook = "", ...rest] = (topic.angle || "").split("\n");
    const source: DraftSource = {
      title: topic.title, hook, angle: rest.join("\n"), positioning: opts.positioning ?? "",
      ...(note ? { note: { title: note.title, content: note.content, tags: note.tags } } : {}),
    };
    const [job] = await tx.insert(jobs).values({ userId, type: "draft_generate", status: "queued",
      payload: { draftId: draft!.id, revision: 1, textVersion: draft!.textVersion, source, referenceKind, base } satisfies Payload }).returning();
    return { draft: draft!, topic: updatedTopic!, jobId: job!.id, code: 202 as const };
  });
}

export async function retryDraftGeneration(deps: Deps, userId: number, id: number, base: string) {
  return deps.db.transaction(async tx => {
    await tx.execute(sql`SELECT id FROM drafts WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
    const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.userId, userId)));
    if (!draft) return { error: "草稿不存在", code: 404 as const };
    if (!deps.r2) return { error: "请配置 R2 图片存储后重试", code: 503 as const };
    if (draft.generationState !== "failed") return { error: "只有失败的成稿任务可以重试", code: 409 as const };
    const [prior] = await tx.select().from(jobs).where(and(eq(jobs.type, "draft_generate"), eq(jobs.userId, userId),
      sql`${jobs.payload}->>'draftId' = ${String(id)}`)).orderBy(desc(jobs.id)).limit(1);
    if (!prior) return { error: "成稿任务不存在", code: 404 as const };
    const revision = draft.generationRevision + 1;
    const [updated] = await tx.update(drafts).set({ generationState: "queued", generationRevision: revision, generationError: null, updatedAt: deps.now() })
      .where(eq(drafts.id, id)).returning();
    const [job] = await tx.insert(jobs).values({
      userId, type: "draft_generate", status: "queued",
      payload: { ...(prior.payload as Payload), revision, textVersion: draft.textVersion, base },
    }).returning();
    return { draft: updated!, jobId: job!.id, code: 202 as const };
  });
}

export async function runDraftJobs(deps: Deps) {
  if (!deps.r2) return;
  await deps.db.update(jobs).set({ status: "queued", claimedAt: null }).where(and(
    eq(jobs.type, "draft_generate"), eq(jobs.status, "processing"), lt(jobs.claimedAt, new Date(deps.now().getTime() - 12 * 60_000)),
  ));
  const [job] = await deps.db.select().from(jobs).where(and(eq(jobs.type, "draft_generate"), eq(jobs.status, "queued"),
    or(isNull(jobs.dueAt), lte(jobs.dueAt, deps.now())))).orderBy(jobs.id).limit(1);
  if (!job) return;
  const [claimed] = await deps.db.update(jobs).set({ status: "processing", claimedAt: deps.now() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued"))).returning();
  if (!claimed) return;
  const p = job.payload as Payload;
  const [draft] = await deps.db.select().from(drafts).where(and(eq(drafts.id, p.draftId), eq(drafts.userId, job.userId)));
  const finish = () => deps.db.update(jobs).set({ status: "done", error: null, finishedAt: deps.now() }).where(eq(jobs.id, job.id));
  if (!draft || draft.generationRevision !== p.revision || draft.generationState === "done") { await finish(); return; }
  try {
    if (draft.textVersion !== p.textVersion) throw new Error("生成期间你已编辑文字，已保留修改；确认后可重新成稿");
    await deps.db.update(drafts).set({ generationState: "writing", generationError: null }).where(and(
      eq(drafts.id, draft.id), eq(drafts.generationRevision, p.revision)));
    const generated = await generateDraft(deps, p.source);
    await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${draft.id} FOR UPDATE`);
      const [current] = await tx.select().from(drafts).where(and(eq(drafts.id, draft.id), eq(drafts.userId, job.userId)));
      if (!current || current.generationRevision !== p.revision || current.generationState === "done") return;
      if (current.textVersion !== p.textVersion) throw new Error("生成期间你已编辑文字，已保留修改；确认后可重新成稿");
      const spec: CoverSpec = automaticCoverSpec(generated.cover || generated.title, p.referenceKind, {
        points: generated.coverPoints, comparison: generated.coverComparison,
      });
      const [written] = await tx.update(drafts).set({
        title: generated.title, content: generated.content, tags: generated.tags, generationState: "done",
        textVersion: current.textVersion + 1, generationWarnings: generated.warnings, generationError: null, coverSpec: spec, updatedAt: deps.now(),
      }).where(eq(drafts.id, current.id)).returning();
      if (!current.coverAssetId && current.images.length >= IMAGE_UPLOAD_LIMITS.images) {
        await tx.update(drafts).set({ coverState: "failed", coverError: "请先移除一张图片，为封面留出位置" }).where(eq(drafts.id, current.id));
      } else await queueCover(tx as unknown as Db, deps, written!, spec, p.base);
    });
    await finish();
  } catch (error) {
    const message = error instanceof Error ? error.message : "AI 成稿失败";
    await deps.db.update(drafts).set({ generationState: "failed", generationError: message, updatedAt: deps.now() })
      .where(and(eq(drafts.id, p.draftId), eq(drafts.userId, job.userId), eq(drafts.generationRevision, p.revision)));
    await deps.db.update(jobs).set({ status: "failed", error: message, finishedAt: deps.now() }).where(eq(jobs.id, job.id));
  }
}

export function startDraftWorker(deps: Deps) {
  let writing = false, rendering = false;
  const write = async () => {
    if (writing) return;
    writing = true;
    try { await runDraftJobs(deps); }
    catch (e) { console.warn("draft worker failed", e); }
    finally { writing = false; }
  };
  const render = async () => {
    if (rendering) return;
    rendering = true;
    try { await runCoverJobs(deps); }
    catch (e) { console.warn("cover worker failed", e); }
    finally { rendering = false; }
  };
  // A slow model request must not block deterministic cover regeneration.
  void write(); void render();
  return setInterval(() => { void write(); void render(); }, 2000).unref();
}
