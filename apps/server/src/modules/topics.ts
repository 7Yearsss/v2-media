import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import type { Db } from "../db";
import { createTopicDraft } from "../lib/draft-jobs";
import { publicBase } from "../lib/media-store";
import { draftWithUploads } from "../lib/draft-media";
import { ACCOUNT_PERSONA_LIMITS, type TopicAnalysisSource } from "@v2media/shared";
import {
  collectedNotes,
  collectionAnalyses,
  collections,
  hostedAccounts,
  topics,
} from "../db/schema";

const TOPIC_STATUSES = ["idea", "planned", "drafted", "published", "archived"] as const;

const createSchema = z.object({
  title: z.string().trim().min(1, "title required").max(512),
  angle: z.string().max(4000).default(""),
  collectionId: z.number().int().positive().optional(),
  sourceNoteId: z.number().int().positive().optional(),
  accountId: z.number().int().positive().optional(),
  analysisId: z.number().int().positive().optional(),
  analysisIdeaIndex: z.number().int().nonnegative().optional(),
  plannedAt: z.number().int().optional(),
}).refine(p => (p.analysisId === undefined) === (p.analysisIdeaIndex === undefined), "analysisId and analysisIdeaIndex must be supplied together");

const updateSchema = z.object({
  title: z.string().trim().min(1).max(512).optional(),
  angle: z.string().max(4000).optional(),
  status: z.enum(TOPIC_STATUSES).optional(),
  accountId: z.number().int().positive().nullable().optional(),
  plannedAt: z.number().int().nullable().optional(),
});

/** 列表行带展示用关联名（库名/账号昵称/来源笔记标题）。 */
const listSelect = {
  topic: topics,
  collectionName: collections.name,
  accountNickname: hostedAccounts.nickname,
  sourceNoteTitle: collectedNotes.title,
};

export function topicsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  const owned = async (userId: number, id: number) => {
    const [row] = await deps.db
      .select()
      .from(topics)
      .where(and(eq(topics.id, id), eq(topics.userId, userId)))
      .limit(1);
    return row ?? null;
  };

  /** 校验可空外键归属（collection/sourceNote/account 都必须是本人的）。 */
  const checkRefs = async (
    userId: number,
    refs: { collectionId?: number | null; sourceNoteId?: number | null; accountId?: number | null },
    db: Db = deps.db,
  ) => {
    if (refs.collectionId) {
      const [r] = await db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.id, refs.collectionId), eq(collections.userId, userId)))
        .limit(1);
      if (!r) return { error: "collection not found", code: 404 as const };
    }
    if (refs.sourceNoteId) {
      const [r] = await db
        .select({ id: collectedNotes.id })
        .from(collectedNotes)
        .where(and(eq(collectedNotes.id, refs.sourceNoteId), eq(collectedNotes.userId, userId)))
        .limit(1);
      if (!r) return { error: "source note not found", code: 404 as const };
    }
    if (refs.accountId) {
      const [r] = await db
        .select({ id: hostedAccounts.id, archivedAt: hostedAccounts.archivedAt })
        .from(hostedAccounts)
        .where(and(eq(hostedAccounts.id, refs.accountId), eq(hostedAccounts.userId, userId)))
        .limit(1);
      if (!r) return { error: "account not found", code: 404 as const };
      if (r.archivedAt) return { error: "账号已归档，请恢复或选择活跃账号", code: 409 as const };
    }
    return null;
  };

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const status = c.req.query("status");
    const conds = [eq(topics.userId, userId)];
    if (status && (TOPIC_STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(topics.status, status));
    }
    const rows = await deps.db
      .select(listSelect)
      .from(topics)
      .leftJoin(collections, eq(topics.collectionId, collections.id))
      .leftJoin(hostedAccounts, eq(topics.accountId, hostedAccounts.id))
      .leftJoin(collectedNotes, eq(topics.sourceNoteId, collectedNotes.id))
      .where(and(...conds))
      .orderBy(desc(topics.updatedAt));
    return c.json({
      items: rows.map((r) => ({
        ...r.topic,
        collectionName: r.collectionName ?? undefined,
        accountNickname: r.accountNickname ?? undefined,
        sourceNoteTitle: r.sourceNoteTitle ?? undefined,
      })),
    });
  });

  app.get("/:id", async c => {
    const userId = c.get("userId"), id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad topic id" }, 400);
    const [row] = await deps.db.select(listSelect).from(topics)
      .leftJoin(collections, and(eq(topics.collectionId, collections.id), eq(collections.userId, userId)))
      .leftJoin(hostedAccounts, and(eq(topics.accountId, hostedAccounts.id), eq(hostedAccounts.userId, userId)))
      .leftJoin(collectedNotes, and(eq(topics.sourceNoteId, collectedNotes.id), eq(collectedNotes.userId, userId)))
      .where(and(eq(topics.id, id), eq(topics.userId, userId))).limit(1);
    return row ? c.json({ ...row.topic, collectionName: row.collectionName ?? undefined,
      accountNickname: row.accountNickname ?? undefined, sourceNoteTitle: row.sourceNoteTitle ?? undefined })
      : c.json({ error: "topic not found" }, 404);
  });

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const result = await deps.db.transaction(async tx => {
      const p = parsed.data;
      let analysisSource: TopicAnalysisSource | null = null;
      let accountId = p.accountId;
      if (p.analysisId !== undefined) {
        await tx.execute(sql`SELECT id FROM collection_analyses WHERE id = ${p.analysisId} AND user_id = ${userId} FOR SHARE`);
        const [analysis] = await tx.select().from(collectionAnalyses)
          .where(and(eq(collectionAnalyses.id, p.analysisId), eq(collectionAnalyses.userId, userId)));
        if (!analysis) return { error: "来源分析不存在，请重新打开报告", code: 404 as const };
        if (analysis.status !== "done") return { error: "来源分析尚未完成或已失败", code: 409 as const };
        const idea = analysis.data.insight?.ideas?.[p.analysisIdeaIndex!];
        if (!idea || p.collectionId !== analysis.collectionId || p.title !== idea.title.trim()
          || p.angle !== `${idea.hook}\n${idea.angle}` || p.sourceNoteId !== idea.refs?.[0]?.id)
          return { error: "分析建议与来源不一致，请重新打开报告", code: 409 as const };
        const target = analysis.data.persona?.accountId ?? null;
        if (p.accountId !== undefined && p.accountId !== target)
          return { error: "分析建议的目标账号不一致，请先入池再明确更换写作账号", code: 409 as const };
        accountId = target ?? undefined;
        analysisSource = { analysisId: analysis.id, collectionId: analysis.collectionId, ideaIndex: p.analysisIdeaIndex!,
          positioning: analysis.data.positioning ?? analysis.data.persona?.positioning,
          persona: analysis.data.persona ?? null };
      }
      if (accountId) await tx.execute(sql`SELECT id FROM hosted_accounts WHERE id = ${accountId} AND user_id = ${userId} FOR SHARE`);
      if (p.sourceNoteId) await tx.execute(sql`SELECT id FROM collected_notes WHERE id = ${p.sourceNoteId} AND user_id = ${userId} FOR SHARE`);
      const refErr = await checkRefs(userId, { ...p, accountId }, tx as unknown as Db);
      if (refErr) return refErr;
      if (analysisSource && p.sourceNoteId) {
        const [note] = await tx.select({ collectionId: collectedNotes.collectionId }).from(collectedNotes)
          .where(and(eq(collectedNotes.id, p.sourceNoteId), eq(collectedNotes.userId, userId)));
        if (note?.collectionId !== analysisSource.collectionId)
          return { error: "来源笔记已移出分析库，请重新分析", code: 409 as const };
      }
      const [row] = await tx
        .insert(topics)
        .values({
          userId,
          title: p.title,
          angle: p.angle,
          sourceType: p.sourceNoteId ? "note" : p.collectionId ? "collection" : "manual",
          collectionId: p.collectionId,
          sourceNoteId: p.sourceNoteId,
          accountId,
          analysisSource,
          plannedAt: p.plannedAt ? new Date(p.plannedAt) : null,
          status: p.plannedAt ? "planned" : "idea",
        })
        .returning();
      return { row: row!, code: 201 as const };
    });
    if ("error" in result) return c.json({ error: result.error }, result.code);
    return c.json(result.row, result.code);
  });

  app.patch("/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    if (p.accountId) {
      const refErr = await checkRefs(userId, { accountId: p.accountId });
      if (refErr) return c.json({ error: refErr.error }, refErr.code);
    }
    // 状态约束：drafted/published 只能由系统流转（to-draft / 发布回填），手动归档除外
    if (p.status === "drafted" || p.status === "published") {
      const t = await owned(userId, id);
      if (!t) return c.json({ error: "not found" }, 404);
      if (t.status !== p.status) return c.json({ error: "该状态由系统流转，不能手动设置" }, 400);
    }
    const patch: Record<string, unknown> = { updatedAt: deps.now() };
    if (p.title !== undefined || p.angle !== undefined || p.accountId !== undefined) {
      const current = await owned(userId, id);
      if (!current) return c.json({ error: "not found" }, 404);
      if ((p.title !== undefined && p.title !== current.title) || (p.angle !== undefined && p.angle !== current.angle)
        || (p.accountId !== undefined && p.accountId !== current.accountId)) {
        patch.score = null; patch.scoreDetail = null; patch.scoreMethod = null; patch.scoreModel = null; patch.scoredAt = null;
      }
    }
    if (p.title !== undefined) patch.title = p.title;
    if (p.angle !== undefined) patch.angle = p.angle;
    if (p.status !== undefined) patch.status = p.status;
    if (p.accountId !== undefined) patch.accountId = p.accountId;
    if (p.plannedAt !== undefined) {
      patch.plannedAt = p.plannedAt ? new Date(p.plannedAt) : null;
      // 给了排期但状态还是 idea → 自动进 planned；清掉排期的 planned → 回 idea
      if (p.plannedAt && p.status === undefined) patch.status = "planned";
      if (!p.plannedAt && p.status === undefined) {
        const t = await owned(userId, id);
        if (t?.status === "planned") patch.status = "idea";
      }
    }
    const [row] = await deps.db
      .update(topics)
      .set(patch)
      .where(and(eq(topics.id, id), eq(topics.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const [row] = await deps.db
      .delete(topics)
      .where(and(eq(topics.id, Number(c.req.param("id"))), eq(topics.userId, userId)))
      .returning({ id: topics.id });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  /** AI 立即排持久任务；手写转稿继续兼容，topic 锁保证并发幂等。 */
  app.post("/:id/to-draft", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const opts = z.object({ ai: z.boolean().optional(), positioning: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.positioning).optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!opts.success) return c.json({ error: "bad payload" }, 400);
    const result = await createTopicDraft(deps, c.get("userId"), id, opts.data, publicBase(c.req));
    if ("error" in result) return c.json({ error: result.error }, result.code!);
    return c.json({ draft: await draftWithUploads(deps.db, result.draft), topic: result.topic,
      ...("jobId" in result ? { jobId: result.jobId } : {}) }, result.code);
  });

  return app;
}
