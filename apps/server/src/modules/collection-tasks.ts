import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { COLLECTION_CAPABILITY, mergeComments, xhsTaskNoteUrl, type CollectionTaskClaim, type NoteCard, type NoteComment } from "@v2media/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { collectedNotes, collections, collectionTaskItems, collectionTasks } from "../db/schema";
import { activeCollectionStatuses, COLLECTION_LEASE_MS, itemView, ownCollectionTask, taskView } from "../lib/collection-task-data";
import { cardSchema, detailSchema, ingestCollect } from "../lib/collect-ingest";
import { publicBase } from "../lib/media-store";

const createSchema = z.object({ keyword: z.string().trim().min(1).max(80), collectionId: z.number().int().positive(), minLikes: z.number().int().min(0).max(10_000_000).default(1000),
  scanLimit: z.number().int().min(1).max(300).default(60), saveLimit: z.number().int().min(1).max(30).default(10),
  commentLimit: z.number().int().min(0).max(200).default(50), intervalMs: z.number().int().min(2000).max(15000).default(5000) })
  .strict().refine(r => r.saveLimit <= r.scanLimit, "入库上限不能大于扫描上限");
const leaseSchema = z.object({ leaseId: z.string().uuid(), revision: z.number().int().nonnegative() });
const noteIdSchema = z.string().regex(/^[0-9a-f]{24}$/i).transform(id => id.toLowerCase());
const taskDetailSchema = detailSchema.extend({ noteId: noteIdSchema, likes: z.number().int().min(0).max(2_147_483_647),
  comments: z.number().int().min(0).max(2_147_483_647) });
const taskCardSchema = cardSchema.extend({ noteId: noteIdSchema, likes: z.number().int().min(0).max(2_147_483_647) });
const clearLease = { leaseId: null, claimedBy: null, leaseUntil: null };
const countSaved = (items: Array<{ collectedNoteId: number | null }>) => items.filter(i => i.collectedNoteId !== null).length;
const candidates = (items: Array<typeof collectionTaskItems.$inferSelect>, limit: number) => {
  const pending = items.filter(i => i.status === "pending"), slots = Math.max(0, limit - countSaved(items));
  return [...pending.filter(i => i.collectedNoteId !== null), ...pending.filter(i => i.collectedNoteId === null).slice(0, slots)].map(i => ({ noteId: i.noteId, card: i.card }));
};
function trimComments(comments: NoteComment[], limit: number) {
  let left = limit; const trimmed: NoteComment[] = [];
  for (const c of mergeComments([], comments)) { if (left <= 0) break; left--; const replies = (c.subComments ?? []).slice(0, left); left -= replies.length; trimmed.push({ ...c, subComments: replies }); }
  return trimmed;
}
export function collectionTasksModule(deps: Deps, extension = false) {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.use("*", bodyLimit({ maxSize: 2 * 1024 * 1024 }));
  app.use("*", async (c, next) => { const id = c.req.param("id"); if (id && (!Number.isInteger(Number(id)) || Number(id) <= 0)) return c.json({ error: "bad id" }, 400); await next(); });
  const lock = async (db: Db, userId: number, id: number) => {
    await db.execute(sql`SELECT id FROM collection_tasks WHERE id=${id} AND user_id=${userId} FOR UPDATE`);
    return ownCollectionTask(db, userId, id);
  };
  if (!extension) {
    app.get("/", async c => {
      const rows = await deps.db.select().from(collectionTasks).where(eq(collectionTasks.userId, c.get("userId"))).orderBy(desc(collectionTasks.id)).limit(50);
      return c.json({ items: await Promise.all(rows.map(t => taskView(deps.db, t))) });
    });
    app.post("/", async c => {
      const p = createSchema.safeParse(await c.req.json().catch(() => null));
      if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "任务参数无效" }, 400);
      const userId = c.get("userId");
      const result = await deps.db.transaction(async tx => {
        // Serialize capacity and claims for the same user across browsers.
        await tx.execute(sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`);
        const [col] = await tx.select().from(collections).where(and(eq(collections.id, p.data.collectionId), eq(collections.userId, userId)));
        if (!col) return { error: "collection not found", code: 404 as const };
        const active = await tx.select({ id: collectionTasks.id }).from(collectionTasks).where(and(eq(collectionTasks.userId, userId), inArray(collectionTasks.status, activeCollectionStatuses)));
        if (active.length >= 10) return { error: "最多保留 10 个未结束任务，请先取消或完成已有任务", code: 409 as const };
        const [task] = await tx.insert(collectionTasks).values({ userId, collectionId: col.id, collectionName: col.name, rules: p.data, updatedAt: deps.now() }).returning();
        return { task: await taskView(tx as unknown as Db, task!) };
      });
      return "error" in result ? c.json({ error: result.error }, result.code) : c.json(result.task, 201);
    });
    app.get("/:id", async c => {
      const id = Number(c.req.param("id")), offset = Number(c.req.query("offset") ?? 0);
      if (!Number.isInteger(id) || id <= 0 || !Number.isInteger(offset) || offset < 0) return c.json({ error: "bad id/offset" }, 400);
      const task = await ownCollectionTask(deps.db, c.get("userId"), id); if (!task) return c.json({ error: "not found" }, 404);
      const items = await deps.db.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, id)).orderBy(asc(collectionTaskItems.id)).limit(51).offset(offset);
      return c.json({ task: await taskView(deps.db, task), items: items.slice(0, 50).map(itemView), nextOffset: items.length > 50 ? offset + 50 : null });
    });
    app.post("/:id/control", async c => {
      const p = z.object({ revision: z.number().int().nonnegative(), action: z.enum(["pause", "resume", "cancel"]) }).strict().safeParse(await c.req.json().catch(() => null));
      if (!p.success) return c.json({ error: "bad payload" }, 400);
      const result = await deps.db.transaction(async tx => {
        const task = await lock(tx as unknown as Db, c.get("userId"), Number(c.req.param("id")));
        if (!task) return { error: "not found", code: 404 as const };
        if (task.revision !== p.data.revision) return { error: "任务状态已变化，请刷新", code: 409 as const };
        const allowed = p.data.action === "cancel" ? !["done", "canceled"].includes(task.status) : p.data.action === "pause" ? ["queued", "running"].includes(task.status) : ["paused", "blocked", "failed", "partial"].includes(task.status);
        if (!allowed) return { error: "当前状态不能执行此操作", code: 409 as const };
        if (p.data.action === "resume" && !task.collectionId) return { error: "目标库已删除，不能恢复；请新建任务", code: 409 as const };
        if (p.data.action === "resume") await tx.update(collectionTaskItems).set({ status: "pending", reason: null }).where(and(eq(collectionTaskItems.taskId, task.id), inArray(collectionTaskItems.status, ["failed", "partial"])));
        const [updated] = await tx.update(collectionTasks).set({ status: p.data.action === "resume" ? "queued" : p.data.action === "pause" ? "paused" : "canceled",
          controlRevision: task.revision + 1, lastControlAction: p.data.action,
          ...clearLease, revision: task.revision + 1, reason: p.data.action === "resume" ? null : p.data.action === "pause" ? "用户暂停" : "用户取消", updatedAt: deps.now() }).where(eq(collectionTasks.id, task.id)).returning();
        return { task: await taskView(tx as unknown as Db, updated!) };
      });
      return "error" in result ? c.json({ error: result.error }, result.code) : c.json(result.task);
    });
    return app;
  }
  app.post("/claim", async c => {
    const p = z.object({ capability: z.literal(COLLECTION_CAPABILITY), claimedBy: z.string().min(1).max(128) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "新版关键词采集能力必需" }, 400);
    const userId = c.get("userId");
    const result = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`);
      await tx.update(collectionTasks).set({ status: "queued", ...clearLease, revision: sql`${collectionTasks.revision}+1`, reason: "浏览器离线，等待重新认领", updatedAt: deps.now() })
        .where(and(eq(collectionTasks.userId, userId), eq(collectionTasks.status, "running"), lt(collectionTasks.leaseUntil, deps.now())));
      const active = await tx.select().from(collectionTasks).where(and(eq(collectionTasks.userId, userId), inArray(collectionTasks.status, ["running", "blocked"])));
      if (active.length) return null;
      const [candidate] = await tx.select().from(collectionTasks).where(and(eq(collectionTasks.userId, userId), eq(collectionTasks.status, "queued"))).orderBy(asc(collectionTasks.id)).limit(1);
      if (!candidate) return null;
      const task = await lock(tx as unknown as Db, userId, candidate.id);
      if (!task || task.status !== "queued") return null;
      if (!task.collectionId) { await tx.update(collectionTasks).set({ status: "failed", reason: "目标库已删除", ...clearLease, updatedAt: deps.now() }).where(eq(collectionTasks.id, task.id)); return null; }
      const [claimed] = await tx.update(collectionTasks).set({ status: "running", leaseId: randomUUID(), claimedBy: p.data.claimedBy,
        leaseUntil: new Date(deps.now().getTime() + COLLECTION_LEASE_MS), revision: task.revision + 1, reason: null, updatedAt: deps.now() }).where(eq(collectionTasks.id, task.id)).returning();
      const pending = await tx.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, task.id)).orderBy(asc(collectionTaskItems.id));
      return { task: await taskView(tx as unknown as Db, claimed!), leaseId: claimed!.leaseId!, pending: candidates(pending, task.rules.saveLimit) } satisfies CollectionTaskClaim;
    });
    return c.json({ claim: result });
  });
  // All worker mutations share the task lock with pause/cancel and the ingest transaction.
  const mutate = async (userId: number, id: number, lease: z.infer<typeof leaseSchema>, fn: (db: Db, task: typeof collectionTasks.$inferSelect) => Promise<unknown>) => deps.db.transaction(async tx => {
    const task = await lock(tx as unknown as Db, userId, id);
    if (!task) return { error: "not found", code: 404 as const };
    if (task.status !== "running" || task.leaseId !== lease.leaseId || task.revision !== lease.revision || !task.leaseUntil || task.leaseUntil <= deps.now()) return { error: "执行租约失效，已停止采集", code: 409 as const };
    if (!task.collectionId) return { error: "目标库已删除，请取消任务", code: 409 as const };
    await tx.update(collectionTasks).set({ leaseUntil: new Date(deps.now().getTime() + COLLECTION_LEASE_MS), updatedAt: deps.now() }).where(eq(collectionTasks.id, task.id));
    return { result: await fn(tx as unknown as Db, task) };
  });
  const respond = (c: any, r: Awaited<ReturnType<typeof mutate>>) => "error" in r ? c.json({ error: r.error }, r.code) : c.json(r.result);
  app.post("/:id/heartbeat", async c => {
    const p = leaseSchema.strict().safeParse(await c.req.json().catch(() => null)); if (!p.success) return c.json({ error: "bad payload" }, 400);
    return respond(c, await mutate(c.get("userId"), Number(c.req.param("id")), p.data, async (db, task) => ({ task: await taskView(db, task) })));
  });
  app.post("/:id/discover", async c => {
    const p = leaseSchema.extend({ cards: z.array(taskCardSchema).max(50), scrollSteps: z.number().int().min(0).max(50), exhausted: z.boolean().optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success || p.data.cards.some(card => !xhsTaskNoteUrl(card.url, card.noteId))) return c.json({ error: "搜索卡片或进度无效" }, 400);
    return respond(c, await mutate(c.get("userId"), Number(c.req.param("id")), p.data, async (db, task) => {
      if (task.phase !== "search") return { task: await taskView(db, task) };
      const existing = await db.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, task.id));
      const seen = new Set(existing.map(i => i.noteId)); let scanned = existing.length;
      for (const card of p.data.cards) { if (seen.has(card.noteId) || scanned >= task.rules.scanLimit) continue; seen.add(card.noteId); scanned++;
        await db.insert(collectionTaskItems).values({ taskId: task.id, noteId: card.noteId, card: { ...card, source: "search" } as NoteCard,
          status: card.likes < task.rules.minLikes ? "skipped" : "pending", reason: card.likes < task.rules.minLikes ? `点赞 ${card.likes} 低于 ${task.rules.minLikes}` : null }).onConflictDoNothing(); }
      const rows = await db.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, task.id)).orderBy(asc(collectionTaskItems.id));
      const stop = p.data.exhausted || scanned >= task.rules.scanLimit || rows.filter(i => i.status === "pending").length >= task.rules.saveLimit || p.data.scrollSteps >= 50;
      const [updated] = await db.update(collectionTasks).set({ phase: stop ? "details" : "search", scrollSteps: Math.max(task.scrollSteps, p.data.scrollSteps),
        reason: stop ? scanned >= task.rules.scanLimit ? "达到扫描上限" : p.data.exhausted ? "搜索无更多结果或持续无增量" : "已发现足够候选 / 滚动上限" : null }).where(eq(collectionTasks.id, task.id)).returning();
      return { task: await taskView(db, updated!), pending: candidates(rows, task.rules.saveLimit) };
    }));
  });
  app.post("/:id/item", async c => {
    const p = leaseSchema.extend({ noteId: noteIdSchema, detail: taskDetailSchema.optional(), commentsHasMore: z.boolean().optional(), error: z.string().max(1000).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success || (!p.data.detail && !p.data.error)) return c.json({ error: "bad payload" }, 400);
    return respond(c, await mutate(c.get("userId"), Number(c.req.param("id")), p.data, async (db, task) => {
      const [item] = await db.select().from(collectionTaskItems).where(and(eq(collectionTaskItems.taskId, task.id), eq(collectionTaskItems.noteId, p.data.noteId)));
      if (!item || item.status !== "pending" || task.phase !== "details") return { ignored: true };
      const items = await db.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, task.id));
      if (countSaved(items) >= task.rules.saveLimit && !item.collectedNoteId) return { ignored: true };
      const detail = p.data.detail;
      if (p.data.error || !detail || detail.noteId !== item.noteId || !xhsTaskNoteUrl(detail.url, item.noteId)
        || (detail.type === "video" ? !detail.videoUrl : !detail.images.length)) {
        await db.update(collectionTaskItems).set({ status: "failed", reason: p.data.error || "未采到匹配笔记的完整详情/媒体" }).where(eq(collectionTaskItems.id, item.id)); return { saved: false };
      }
      if (detail.likes < task.rules.minLikes) { await db.update(collectionTaskItems).set({ status: "skipped", reason: "详情核验点赞未达门槛" }).where(eq(collectionTaskItems.id, item.id)); return { saved: false }; }
      const comments = trimComments((detail.commentsData ?? []) as NoteComment[], task.rules.commentLimit);
      const replies = comments.reduce((s, cm) => s + (cm.subComments?.length ?? 0), 0);
      const missingReplies = comments.some(cm => (cm.subCommentCount ?? 0) > (cm.subComments?.length ?? 0));
      const coverage = !task.rules.commentLimit ? "not_requested" : detail.comments === 0 && !comments.length && p.data.commentsHasMore === false ? "none"
        : p.data.commentsHasMore === false && !missingReplies && comments.length + replies >= detail.comments ? "complete" : "partial";
      const [existed] = await db.select({ id: collectedNotes.id }).from(collectedNotes).where(and(eq(collectedNotes.userId, task.userId), eq(collectedNotes.noteId, item.noteId)));
      const ingested = await ingestCollect({ ...deps, db }, task.userId, { source: "search", collectionId: task.collectionId,
        context: { keyword: task.rules.keyword }, items: [item.card], details: [{ ...detail, commentsData: comments }] }, publicBase(c.req));
      if ("error" in ingested) throw new Error(ingested.error);
      await db.update(collectionTaskItems).set({ status: coverage === "partial" ? "partial" : "saved", collectedNoteId: ingested.ids[0], alreadyExisted: item.collectedNoteId ? item.alreadyExisted : !!existed,
        platformComments: detail.comments, capturedComments: comments.length, capturedReplies: replies, commentCoverage: coverage,
        reason: coverage === "partial" ? "评论部分采集（上限、缺回复或未确认末页）" : null }).where(eq(collectionTaskItems.id, item.id));
      return { saved: true };
    }));
  });
  app.post("/:id/finish", async c => {
    const p = leaseSchema.extend({ outcome: z.enum(["done", "yield", "blocked", "failed"]), reason: z.string().min(1).max(1000).optional() }).strict().safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: "bad payload" }, 400);
    return respond(c, await mutate(c.get("userId"), Number(c.req.param("id")), p.data, async (db, task) => {
      const items = await db.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, task.id)), saved = countSaved(items);
      const unfinished = items.some(i => ["pending", "failed", "partial"].includes(i.status));
      const state = p.data.outcome === "yield" ? "queued" : p.data.outcome === "blocked" ? "blocked" : p.data.outcome === "failed" ? "failed"
        : task.phase === "search" ? "partial" : unfinished && saved < task.rules.saveLimit ? "partial" : items.some(i => i.commentCoverage === "partial") ? "partial" : "done";
      const [updated] = await db.update(collectionTasks).set({ status: state, ...clearLease, revision: task.revision + 1,
        reason: p.data.reason ?? (state === "partial" ? "有未完成详情或评论，请查看逐篇结果" : saved >= task.rules.saveLimit ? "达到入库上限" : task.reason ?? "候选处理完成"), updatedAt: deps.now() }).where(eq(collectionTasks.id, task.id)).returning();
      return { task: await taskView(db, updated!) };
    }));
  });
  return app;
}
