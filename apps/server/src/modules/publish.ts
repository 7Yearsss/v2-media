import { and, desc, eq, inArray, notInArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { browserExecutionReceipts, drafts, hostedAccounts, mediaAssets, publishJobs, topics } from "../db/schema";
import { snapshotPersona } from "../lib/account-persona";
import { hasLiveLease } from "../lib/browser-execution";

const createSchema = z.object({
  draftId: z.number().int(),
  accountId: z.number().int().positive(),
  personaVersion: z.number().int().nonnegative().optional(),
  draftTextVersion: z.number().int().nonnegative().optional(),
  draftImagesVersion: z.number().int().nonnegative().optional(),
  scheduledAt: z.number().int().optional(),
  visibility: z.enum(["public", "private", "friends"]).default("public"),
});
const retrySchema = z.object({ operationId: z.string().uuid() }).strict();
type PublishRow = typeof publishJobs.$inferSelect;
type AccountRow = typeof hostedAccounts.$inferSelect;

function retryEligibility(job: PublishRow, account: AccountRow | undefined, hasReceipt: boolean, existingChildId?: number, draftArchived = false) {
  if (account?.archivedAt || draftArchived)
    return { allowed: false, reason: "原账号或草稿已归档，请先恢复并核对后再重试" };
  if (!["failed", "canceled"].includes(job.status))
    return { allowed: false, reason: "只能重试确认失败或执行前取消的任务；执行结果未知时请先人工核对" };
  if (existingChildId) return { allowed: false, reason: `已有原版本重试任务 #${existingChildId} 正在排队、执行或已发布，请先核对该任务` };
  if (job.resultUrl || job.noteId || job.publishedAt || job.reportedAt || job.outcome)
    return { allowed: false, reason: "原任务已有发布结果或核对证据，请人工核对，勿直接重发" };
  const definite = job.status === "canceled"
    ? job.attempt === 0 && !job.claimedBy && !job.leaseId
    : job.attempt > 0 && !!job.claimedBy && !!job.leaseId && hasReceipt;
  if (!definite) return { allowed: false, reason: "历史任务缺少明确的执行结果，不能确认未发布，请先人工核对" };
  if (!job.draftSnapshot || !job.personaSnapshot || !job.accountSnapshot || typeof job.accountSnapshot.xhsUserId !== "string" || !job.accountSnapshot.xhsUserId.trim()
    || !Number.isInteger(job.personaSnapshot.version) || [job.personaSnapshot.positioning, job.personaSnapshot.styleNotes, job.personaSnapshot.redlines].some(value => typeof value !== "string"))
    return { allowed: false, reason: "原任务缺少完整快照，无法重试原版本；请核对后用当前稿新建发布" };
  if (typeof job.draftSnapshot.title !== "string" || !job.draftSnapshot.title.trim() || typeof job.draftSnapshot.content !== "string"
    || !Array.isArray(job.draftSnapshot.tags) || job.draftSnapshot.tags.some(tag => typeof tag !== "string")
    || !Array.isArray(job.draftSnapshot.images) || !job.draftSnapshot.images.length || job.draftSnapshot.images.some(image => !image || typeof image.url !== "string" || !image.url.trim()))
    return { allowed: false, reason: "原任务图片或标题不完整，无法重试原版本" };
  if (!account || account.id !== job.accountSnapshot.accountId || account.xhsUserId !== job.accountSnapshot.xhsUserId || job.personaSnapshot.accountId !== account.id)
    return { allowed: false, reason: "原发布账号不存在或身份已改变，请核对后用当前稿新建发布" };
  return { allowed: true };
}

export function publishModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/jobs", async (c) => {
    const rows = await deps.db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.userId, c.get("userId")))
      .orderBy(desc(publishJobs.id))
      .limit(200);
    const [accounts, receipts, children, draftRows] = rows.length ? await Promise.all([
      deps.db.select().from(hostedAccounts).where(and(eq(hostedAccounts.userId, c.get("userId")), inArray(hostedAccounts.id, rows.map(row => row.accountId)))),
      deps.db.select({ executionId: browserExecutionReceipts.executionId }).from(browserExecutionReceipts).where(and(
        eq(browserExecutionReceipts.userId, c.get("userId")), eq(browserExecutionReceipts.domain, "publish"), inArray(browserExecutionReceipts.executionId, rows.map(row => row.id)))),
      deps.db.select({ id: publishJobs.id, sourceId: publishJobs.retryOfJobId }).from(publishJobs).where(and(
        eq(publishJobs.userId, c.get("userId")), inArray(publishJobs.retryOfJobId, rows.map(row => row.id)), notInArray(publishJobs.status, ["failed", "canceled"]))),
      deps.db.select({ id: drafts.id, archivedAt: drafts.archivedAt }).from(drafts).where(and(eq(drafts.userId, c.get("userId")), inArray(drafts.id, rows.map(row => row.draftId)))),
    ]) : [[], [], [], []];
    const accountMap = new Map(accounts.map(account => [account.id, account]));
    const confirmed = new Set(receipts.map(receipt => receipt.executionId));
    const activeChildren = new Map(children.map(child => [child.sourceId, child.id]));
    const archivedDrafts = new Set(draftRows.filter(draft => draft.archivedAt).map(draft => draft.id));
    return c.json(rows.map(row => ({ ...row, retryEligibility: retryEligibility(row, accountMap.get(row.accountId), confirmed.has(row.id), activeChildren.get(row.id), archivedDrafts.has(row.draftId)),
      ...(row.status === "running" && !hasLiveLease(row, deps.now())
        ? { error: `${row.error ? `${row.error}；` : ""}发布执行租约已失效，执行结果未知，请人工核对，勿直接重发` } : {}),
    })));
  });

  app.post("/jobs", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    const result = await deps.db.transaction(async tx => {
      // Freeze the reviewed account fields and draft together; heartbeat/foreign-key locks remain compatible.
      await tx.execute(sql`SELECT id FROM hosted_accounts WHERE id = ${p.accountId} AND user_id = ${userId} FOR SHARE`);
      const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, p.accountId), eq(hostedAccounts.userId, userId)));
      if (!account) return { error: "account not found", code: 404 as const };
      if (account.archivedAt) return { error: "发布账号已归档，请先恢复账号", code: 409 as const };
      if (p.personaVersion !== undefined && p.personaVersion !== account.personaVersion)
        return { error: "目标账号人设已更新，请重新读取并核对红线", code: 409 as const };
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${p.draftId} AND user_id = ${userId} FOR UPDATE`);
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, p.draftId), eq(drafts.userId, userId)));
      if (!draft) return { error: "draft not found", code: 404 as const };
      if (draft.archivedAt) return { error: "草稿已归档，请先恢复草稿", code: 409 as const };
      if ((p.draftTextVersion !== undefined && p.draftTextVersion !== draft.textVersion)
        || (p.draftImagesVersion !== undefined && p.draftImagesVersion !== draft.imagesVersion))
        return { error: "草稿文字或图片已更新，请刷新后重新核对发布版本", code: 409 as const };
      if (["queued", "writing"].includes(draft.generationState) || ["queued", "processing"].includes(draft.coverState))
        return { error: "草稿或封面仍在生成，请完成后再发布", code: 400 as const };
      if (!draft.title.trim() || !draft.images.length) return { error: "草稿需要标题和至少一张图片", code: 400 as const };
      const assets = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.draftId, draft.id), eq(mediaAssets.userId, userId)));
      if (draft.images.some(i => !i.url.trim() || (i.assetId && !assets.some(a => a.id === i.assetId && a.status === "ready" && a.url === i.url))))
        return { error: "草稿图片尚未上传完成，请等待或移除失败图片", code: 400 as const };
      const [topic] = await tx.select().from(topics).where(and(eq(topics.draftId, draft.id), eq(topics.userId, userId))).orderBy(desc(topics.updatedAt), desc(topics.id)).limit(1);
      const [job] = await tx.insert(publishJobs).values({
        userId, draftId: p.draftId, accountId: p.accountId,
        scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : null, visibility: p.visibility,
        accountSnapshot: { accountId: account.id, xhsUserId: account.xhsUserId, nickname: account.nickname },
        draftSnapshot: { title: draft.title, content: draft.content, tags: draft.tags, images: draft.images },
        personaSnapshot: snapshotPersona(account),
        coverSnapshot: draft.coverSpec,
        planningSnapshot: topic ? { version: 1, topicId: topic.id, title: topic.title,
          score: topic.score, scoreDetail: topic.scoreDetail, scoreMethod: topic.scoreMethod,
          scoreModel: topic.scoreModel, scoredAt: topic.scoredAt?.toISOString() ?? null,
          accountId: topic.accountId, persona: topic.personaSnapshot } : null,
      }).returning();
      return { job: job! };
    });
    return "error" in result ? c.json({ error: result.error }, result.code!) : c.json(result.job);
  });

  app.post("/jobs/:id/retry", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const parsed = retrySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const { operationId } = parsed.data;
    const result = await deps.db.transaction(async tx => {
      // A lost HTTP response and a second click acknowledge the same new job.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`publish-retry:${userId}:${operationId}`}, 0))`);
      const [existing] = await tx.select().from(publishJobs).where(and(eq(publishJobs.userId, userId), eq(publishJobs.retryOperationId, operationId)));
      if (existing) return existing.retryOfJobId === id
        ? { job: existing }
        : { error: "operationId 已用于另一条发布任务", code: 409 as const };
      const [identity] = await tx.select({ accountId: publishJobs.accountId, draftId: publishJobs.draftId }).from(publishJobs)
        .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId)));
      if (!identity) return { error: "publish job not found", code: 404 as const };
      // Account → draft → publication order prevents new jobs racing an archive.
      await tx.execute(sql`SELECT id FROM hosted_accounts WHERE id = ${identity.accountId} AND user_id = ${userId} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${identity.draftId} AND user_id = ${userId} FOR SHARE`);
      await tx.execute(sql`SELECT id FROM publish_jobs WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
      const [source] = await tx.select().from(publishJobs).where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId)));
      if (!source) return { error: "publish job not found", code: 404 as const };
      const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, source.accountId), eq(hostedAccounts.userId, userId)));
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, source.draftId), eq(drafts.userId, userId)));
      const [receipt] = await tx.select({ id: browserExecutionReceipts.id }).from(browserExecutionReceipts).where(and(
        eq(browserExecutionReceipts.userId, userId), eq(browserExecutionReceipts.domain, "publish"), eq(browserExecutionReceipts.executionId, id))).limit(1);
      const [child] = await tx.select({ id: publishJobs.id }).from(publishJobs).where(and(eq(publishJobs.userId, userId), eq(publishJobs.retryOfJobId, id), notInArray(publishJobs.status, ["failed", "canceled"]))).limit(1);
      const eligibility = retryEligibility(source, account, !!receipt, child?.id, !!draft?.archivedAt);
      if (!eligibility.allowed) return { error: eligibility.reason, code: 409 as const };
      if (!draft) return { error: "原草稿不存在，请人工核对后新建发布", code: 409 as const };
      const [job] = await tx.insert(publishJobs).values({
        userId, draftId: source.draftId, accountId: source.accountId, visibility: source.visibility,
        scheduledAt: null, retryOfJobId: source.id, retryOperationId: operationId,
        draftSnapshot: source.draftSnapshot, personaSnapshot: source.personaSnapshot,
        accountSnapshot: source.accountSnapshot, coverSnapshot: source.coverSnapshot, planningSnapshot: source.planningSnapshot,
      }).returning();
      return { job: job! };
    });
    return "error" in result ? c.json({ error: result.error }, result.code!) : c.json(result.job);
  });

  app.post("/jobs/:id/cancel", async (c) => {
    const id = Number(c.req.param("id"));
    const [row] = await deps.db
      .update(publishJobs)
      .set({ status: "canceled", updatedAt: deps.now() })
      .where(
        and(
          eq(publishJobs.id, id),
          eq(publishJobs.userId, c.get("userId")),
          eq(publishJobs.status, "pending"),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "not found or not cancelable" }, 404);
    return c.json(row);
  });

  return app;
}
