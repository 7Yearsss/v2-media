import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ingestCollect } from "../lib/collect-ingest";
import { observeAccount, observedAccountSchema } from "../lib/account-identity";

import type {
  AccountSnapshotTaskPayload,
  MetricsTaskPayload,
  PostedNoteItem,
  PublishOutcome,
  ReadbackTaskPayload,
} from "@v2media/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { attributionLeaseMs, browserClaimSchema, browserHeartbeatSchema, browserReceiptFields, capabilityError, hasLiveLease, matchesLease, publishLeaseMs, receiptHash, replayReceipt, saveReceipt, supportsBrowserExecution, terminalMetadata } from "../lib/browser-execution";
import { BROWSER_EXECUTION_CAPABILITY } from "@v2media/shared";
import {
  accountSnapshots,
  drafts,
  hostedAccounts,
  jobs,
  noteMetrics,
  publishJobs,
  topics,
} from "../db/schema";
import { publicBase } from "../lib/media-store";

// ---------- 归因任务调度（jobs 表复用为队列；插件轮询 pending） ----------

const MIN = 60_000;
const HOUR = 60 * MIN;
/** readback 失败重排上限。 */
const READBACK_MAX_ATTEMPTS = 3;

async function scheduleTask(
  deps: Deps,
  userId: number,
  type: string,
  payload: Record<string, unknown>,
  dueAt?: Date,
) {
  await deps.db.insert(jobs).values({ userId, type, payload, dueAt: dueAt ?? null });
}

/** 标题归一化：XHS 已发列表标题可能被截断/改标点，宽松比前缀。 */
function normalizeTitle(s: string): string {
  return s.replace(/\s+/g, "").toLowerCase();
}

function matchPostedNote(
  items: PostedNoteItem[],
  title: string,
  publishedAt: number,
): PostedNoteItem | null {
  const want = normalizeTitle(title);
  if (!want) return null;
  for (const it of items) {
    const got = normalizeTitle(it.title ?? "");
    if (!got) continue;
    if (!(want.startsWith(got) || got.startsWith(want))) continue;
    // 时间窗校验：发布时间需在 [publishedAt-10min, +24h] 内（时间不可解析则仅靠标题）
    const t = it.publishTime;
    const ts = typeof t === "number" ? t : t ? Date.parse(String(t)) : NaN;
    if (Number.isFinite(ts) && (ts < publishedAt - 10 * MIN || ts > publishedAt + 24 * HOUR)) {
      continue;
    }
    return it;
  }
  return null;
}

/** verified 后按 T+1h/24h/168h 排三次指标回采。 */
async function scheduleMetricsTasks(
  deps: Deps,
  userId: number,
  p: MetricsTaskPayload,
  base: Date,
) {
  for (const offsetMs of [HOUR, 24 * HOUR, 168 * HOUR]) {
    await scheduleTask(deps, userId, "metrics", { ...p }, new Date(base.getTime() + offsetMs));
  }
}

/** 账号快照任务：无排队中任务且 20h 内无快照 → 排一个立即执行的。 */
async function ensureSnapshotTask(
  deps: Deps,
  userId: number,
  accountId: number,
  xhsUserId: string,
) {
  const cutoff = new Date(deps.now().getTime() - 20 * HOUR);
  const [pending] = await deps.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.userId, userId),
        eq(jobs.type, "account_snapshot"),
        or(eq(jobs.status, "pending"), eq(jobs.status, "running")),
        sql`${jobs.payload}->>'accountId' = ${String(accountId)}`,
      ),
    )
    .limit(1);
  if (pending) return;
  const [recent] = await deps.db
    .select({ id: accountSnapshots.id })
    .from(accountSnapshots)
    .where(
      and(
        eq(accountSnapshots.userId, userId),
        eq(accountSnapshots.accountId, accountId),
        sql`${accountSnapshots.capturedAt} > ${cutoff}`,
      ),
    )
    .limit(1);
  if (recent) return;
  await scheduleTask(deps, userId, "account_snapshot", { accountId, xhsUserId });
}

const heartbeatSchema = z.object({
  accounts: z.array(observedAccountSchema).max(50),
}).refine(({ accounts }) => new Set(accounts.map(a => `${a.subType}:${a.xhsUserId}`)).size === accounts.length, "duplicate account identity");

const resultSchema = browserReceiptFields.extend({
  status: z.enum(["done", "failed"]),
  resultUrl: z.string().optional(),
  error: z.string().optional(),
});
const taskResultSchema = browserReceiptFields.extend({ status: z.enum(["done", "failed"]), outcome: z.enum(["verified", "unverified", "login_required", "readback_error"]).optional(), error: z.string().max(5000).optional(), data: z.unknown().optional() });
const attributionTypes = ["readback", "metrics", "account_snapshot"];
const postedNoteId = z.preprocess(value => typeof value === "string" && value.trim() && value.trim().length <= 128 ? value.trim() : undefined, z.string().optional());
const postedDataSchema = z.object({ items: z.array(z.object({ noteId: postedNoteId, title: z.string().max(2000).optional(), url: z.string().max(10000).optional(), publishTime: z.union([z.string(), z.number().finite()]).optional(), status: z.string().optional(), xsecToken: z.string().optional() })).max(1000) });
const metricValue = z.number().finite().nullable().optional();
const metricsRowSchema = z.object({ noteId: z.string().min(1).max(128), url: z.string().optional(), views: metricValue, likes: metricValue, collects: metricValue, comments: metricValue, shares: metricValue, exposure: metricValue });
const metricsDataSchema = metricsRowSchema.partial().extend({ rows: z.array(metricsRowSchema).max(1000).optional(), extra: z.record(z.unknown()).optional() }).refine(d => !!d.rows?.length || !!d.noteId, "metrics require a note row");
const snapshotDataSchema = z.object({ followers: metricValue, likesTotal: metricValue, notesCount: metricValue, extra: z.record(z.unknown()).optional() }).refine(d => [d.followers, d.likesTotal, d.notesCount].some(v => typeof v === "number" && v >= 0 && v <= 2_147_483_647), "snapshot requires a valid metric");
const metricNumber = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2_147_483_647 ? Math.round(v) : null;

/** SQL guard is evaluated as part of the execution transition, not a preceding check. */
function activePublishTargets(userId: number) {
  return sql`EXISTS (SELECT 1 FROM hosted_accounts a WHERE a.id = ${publishJobs.accountId} AND a.user_id = ${userId} AND a.archived_at IS NULL)
    AND EXISTS (SELECT 1 FROM drafts d WHERE d.id = ${publishJobs.draftId} AND d.user_id = ${userId} AND d.archived_at IS NULL)`;
}

function snapshotTargetNotArchived(userId: number) {
  return sql`(${jobs.type} <> 'account_snapshot' OR NOT EXISTS (
    SELECT 1 FROM hosted_accounts a WHERE a.id::text = ${jobs.payload}->>'accountId' AND a.user_id = ${userId} AND a.archived_at IS NOT NULL))`;
}

export function extModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.post("/accounts/heartbeat", async (c) => {
    const userId = c.get("userId");
    const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad heartbeat" }, 400);
    const now = deps.now();
    // Stable lock order avoids deadlocks when two heartbeats contain the same identities.
    const accounts = [...parsed.data.accounts].sort((a, b) => `${a.subType}:${a.xhsUserId}`.localeCompare(`${b.subType}:${b.xhsUserId}`));
    await deps.db.transaction(async tx => {
      const scoped = { ...deps, db: tx as unknown as Db };
      for (const acc of accounts) {
        const row = await observeAccount(scoped.db, userId, acc, now);
        // The account UPSERT row lock also serializes the snapshot existence check and insert.
        if (acc.status === "online" && !row.archivedAt) {
          await ensureSnapshotTask(scoped, userId, row.id, row.xhsUserId);
        }
      }
    });
    return c.json({ ok: true });
  });

  /** 卡片批量 upsert；details 里同 noteId 的详情/评论落到对应行。 */
  app.post("/collect", async c => {
    const result = await ingestCollect(deps, c.get("userId"), await c.req.json().catch(() => null), publicBase(c.req));
    return "error" in result ? c.json({ error: result.error, ...("issues" in result ? { issues: result.issues } : {}) }, result.code) : c.json(result);
  });

  /** 该用户所有 pending 且到期的任务（含草稿全文 + 账号 xhsUserId 供插件比对当前登录号）。 ?all=1 含未来定时任务（手动 Run Now 用）。 */
  app.get("/publish/pending", async (c) => {
    const userId = c.get("userId");
    const includeFuture = c.req.query("all") === "1";
    // xhsUserId：插件传当前登录号做服务端过滤，避免不匹配任务占满 limit 名额饿死后面的任务
    const accountFilter = c.req.query("account");
    const rows = await deps.db
      .select({ job: publishJobs, draft: drafts, account: hostedAccounts })
      .from(publishJobs)
      .innerJoin(drafts, eq(publishJobs.draftId, drafts.id))
      .leftJoin(hostedAccounts, eq(publishJobs.accountId, hostedAccounts.id))
      .where(
        and(
          eq(publishJobs.userId, userId),
          eq(publishJobs.status, "pending"),
          isNull(drafts.archivedAt),
          isNull(hostedAccounts.archivedAt),
          includeFuture
            ? undefined
            : or(isNull(publishJobs.scheduledAt), lt(publishJobs.scheduledAt, deps.now())),
          accountFilter ? eq(hostedAccounts.xhsUserId, accountFilter) : undefined,
        ),
      )
      .orderBy(publishJobs.id)
      .limit(10);
    return c.json({
      jobs: rows.map((r) => ({
        ...r.job,
        scheduledAt: r.job.scheduledAt?.getTime(),
        xhsUserId: r.account?.xhsUserId ?? "",
        draft: {
          ...(r.job.draftSnapshot ?? { title: r.draft.title, content: r.draft.content, tags: r.draft.tags, images: r.draft.images }),
        },
      })),
    });
  });

  /** Recovery only exposes an active execution to its capability-aware owner. */
  app.get("/publish/:id", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const [r] = await deps.db.select({ job: publishJobs, draft: drafts, account: hostedAccounts }).from(publishJobs)
      .innerJoin(drafts, eq(publishJobs.draftId, drafts.id)).leftJoin(hostedAccounts, eq(publishJobs.accountId, hostedAccounts.id))
      .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId))).limit(1);
    if (!r) return c.json({ error: "not found" }, 404);
    if (r.job.status === "running") {
      if (c.req.query("capability") !== BROWSER_EXECUTION_CAPABILITY) return c.json(capabilityError, 426);
      if (!c.req.query("claimer") || r.job.claimedBy !== c.req.query("claimer")) return c.json({ error: "not found" }, 404);
      if (!hasLiveLease(r.job, deps.now())) return c.json({ error: "execution lease expired; reconcile required" }, 409);
    } else if (r.job.status !== "pending") return c.json(terminalMetadata(r.job));
    if (r.draft.archivedAt || !r.account || r.account.archivedAt) return c.json({ error: "publish target archived; execution prohibited" }, 409);
    return c.json({ ...r.job, scheduledAt: r.job.scheduledAt?.getTime(), xhsUserId: r.account?.xhsUserId ?? "",
      draft: r.job.draftSnapshot ?? { title: r.draft.title, content: r.draft.content, tags: r.draft.tags, images: r.draft.images } });
  });

  app.post("/publish/:id/claim", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!supportsBrowserExecution(body)) return c.json(capabilityError, 426);
    const parsed = browserClaimSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db.update(publishJobs).set({ status: "running", claimedBy: parsed.data.claimedBy,
      leaseId: randomUUID(), attempt: sql`${publishJobs.attempt} + 1`, leaseUntil: new Date(deps.now().getTime() + publishLeaseMs), updatedAt: deps.now() })
      .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId), eq(publishJobs.status, "pending"), activePublishTargets(userId))).returning();
    if (!row) return c.json({ error: "not found or already claimed" }, 404);
    return c.json(row);
  });

  app.post("/publish/:id/heartbeat", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!supportsBrowserExecution(body)) return c.json(capabilityError, 426);
    const parsed = browserHeartbeatSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data, now = deps.now();
    const [row] = await deps.db.update(publishJobs).set({ leaseUntil: new Date(now.getTime() + publishLeaseMs), updatedAt: now })
      .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId), eq(publishJobs.status, "running"), eq(publishJobs.claimedBy, p.claimedBy), eq(publishJobs.leaseId, p.leaseId), eq(publishJobs.attempt, p.attempt), sql`${publishJobs.leaseUntil} > ${now}`, activePublishTargets(userId))).returning();
    return row ? c.json(terminalMetadata(row)) : c.json({ error: "execution lease expired, superseded or target archived; reconcile required" }, 409);
  });

  app.post("/publish/:id/result", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!supportsBrowserExecution(body)) return c.json(capabilityError, 426);
    const parsed = resultSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data, hash = receiptHash(body);
    const result = await deps.db.transaction(async tx => {
      const replay = await replayReceipt(tx, userId, "publish", id, p.receiptId, hash);
      if (replay) return replay;
      await tx.execute(sql`SELECT id FROM publish_jobs WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
      const [job] = await tx.select().from(publishJobs).where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId)));
      if (!job) return { error: "not found", code: 404 as const };
      const now = deps.now();
      if (!matchesLease(job, p, now)) return { error: "execution lease expired, superseded or not running; reconcile required", code: 409 as const };
      await tx.update(publishJobs).set({ status: p.status, reportedAt: p.status === "done" ? now : null, resultUrl: p.resultUrl ?? null, error: p.error ?? null, leaseUntil: null, updatedAt: now }).where(eq(publishJobs.id, id));
      if (p.status === "done") {
        await tx.update(drafts).set({ status: "published", updatedAt: now }).where(and(eq(drafts.id, job.draftId), eq(drafts.userId, userId)));
        await tx.update(topics).set({ status: "published", publishJobId: id, updatedAt: now }).where(and(eq(topics.draftId, job.draftId), eq(topics.userId, userId)));
        const [existing] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.userId, userId), eq(jobs.type, "readback"), sql`${jobs.payload}->>'publishJobId' = ${String(id)}`)).limit(1);
        if (!existing) {
          const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, job.draftId), eq(drafts.userId, userId)));
          const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, job.accountId), eq(hostedAccounts.userId, userId)));
          await tx.insert(jobs).values({ userId, type: "readback", dueAt: new Date(now.getTime() + 10 * MIN),
            payload: { publishJobId: id, title: job.draftSnapshot?.title ?? draft?.title ?? "", xhsUserId: account?.xhsUserId ?? "", publishedAt: now.getTime() } satisfies ReadbackTaskPayload });
        }
      }
      const ack = { ok: true as const }; await saveReceipt(tx, userId, "publish", id, p.receiptId, hash, ack); return { ack };
    });
    return "error" in result ? c.json({ error: result.error }, result.code) : c.json(result.ack);
  });

  // Attribution operations are repeatable; stale leases can be reclaimed with a new attempt.
  app.get("/tasks/pending", async c => {
    const userId = c.get("userId"), now = deps.now();
    const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 5, 20));
    // Reads never reap leases. A subsequent claim atomically replaces an expired attempt.
    const rows = await deps.db.select({ id: jobs.id, type: jobs.type, payload: jobs.payload }).from(jobs)
      .where(and(eq(jobs.userId, userId), or(eq(jobs.status, "pending"), and(eq(jobs.status, "running"), or(isNull(jobs.leaseId), isNull(jobs.leaseUntil), lte(jobs.leaseUntil, now)))), inArray(jobs.type, attributionTypes), snapshotTargetNotArchived(userId), or(isNull(jobs.dueAt), lte(jobs.dueAt, now))))
      .orderBy(asc(jobs.dueAt), asc(jobs.id)).limit(limit);
    return c.json({ tasks: rows });
  });

  app.get("/tasks/:id", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const [row] = await deps.db.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.userId, userId), inArray(jobs.type, attributionTypes)));
    if (!row) return c.json({ error: "not found" }, 404);
    if (row.status === "running") {
      if (c.req.query("capability") !== BROWSER_EXECUTION_CAPABILITY) return c.json(capabilityError, 426);
      if (!c.req.query("claimer") || row.claimedBy !== c.req.query("claimer")) return c.json({ error: "not found" }, 404);
      if (!hasLiveLease(row, deps.now())) return c.json({ error: "execution lease expired; reconcile required" }, 409);
    } else if (row.status !== "pending") return c.json(terminalMetadata(row));
    if (row.status === "pending" && row.type === "account_snapshot") {
      const accountId = String((row.payload as { accountId?: unknown } | null)?.accountId ?? "");
      const [archived] = await deps.db.select({ id: hostedAccounts.id }).from(hostedAccounts)
        .where(and(eq(hostedAccounts.userId, userId), sql`${hostedAccounts.id}::text = ${accountId}`, sql`${hostedAccounts.archivedAt} IS NOT NULL`)).limit(1);
      if (archived) return c.json({ error: "snapshot target archived; execution prohibited" }, 409);
    }
    return c.json(row);
  });

  app.post("/tasks/:id/claim", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!supportsBrowserExecution(body)) return c.json(capabilityError, 426);
    const parsed = browserClaimSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const now = deps.now();
    const [row] = await deps.db.update(jobs).set({ status: "running", claimedBy: parsed.data.claimedBy, claimedAt: now, finishedAt: null,
      leaseId: randomUUID(), attempt: sql`${jobs.attempt} + 1`, leaseUntil: new Date(now.getTime() + attributionLeaseMs) })
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId), or(eq(jobs.status, "pending"), and(eq(jobs.status, "running"), or(isNull(jobs.leaseId), isNull(jobs.leaseUntil), lte(jobs.leaseUntil, now)))), inArray(jobs.type, attributionTypes), snapshotTargetNotArchived(userId), or(isNull(jobs.dueAt), lte(jobs.dueAt, now)))).returning();
    return row ? c.json(row) : c.json({ error: "not found, not due or already claimed" }, 404);
  });

  app.post("/tasks/:id/heartbeat", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!supportsBrowserExecution(body)) return c.json(capabilityError, 426);
    const parsed = browserHeartbeatSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data, now = deps.now();
    const [row] = await deps.db.update(jobs).set({ leaseUntil: new Date(now.getTime() + attributionLeaseMs) })
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId), inArray(jobs.type, attributionTypes), eq(jobs.status, "running"), eq(jobs.claimedBy, p.claimedBy), eq(jobs.leaseId, p.leaseId), eq(jobs.attempt, p.attempt), sql`${jobs.leaseUntil} > ${now}`)).returning();
    return row ? c.json(terminalMetadata(row)) : c.json({ error: "execution lease expired or superseded; reconcile required" }, 409);
  });

  app.post("/tasks/:id/result", async c => {
    const id = Number(c.req.param("id")), userId = c.get("userId");
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const body: unknown = await c.req.json().catch(() => null);
    if (!supportsBrowserExecution(body)) return c.json(capabilityError, 426);
    const parsed = taskResultSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data, hash = receiptHash(body);
    const result = await deps.db.transaction(async tx => {
      const replay = await replayReceipt(tx, userId, "tasks", id, p.receiptId, hash); if (replay) return replay;
      await tx.execute(sql`SELECT id FROM jobs WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
      const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, id), eq(jobs.userId, userId)));
      if (!job) return { error: "not found", code: 404 as const };
      if (!attributionTypes.includes(job.type)) return { error: "server task cannot be completed by extension", code: 400 as const };
      const now = deps.now(); if (!matchesLease(job, p, now)) return { error: "execution lease expired, superseded or not running", code: 409 as const };
      const payload = (job.payload ?? {}) as Record<string, unknown>, scoped = { ...deps, db: tx as unknown as Db };
      let ack: { ok: true; rescheduled?: boolean } = { ok: true };
      let rescheduled = false;
      if (job.type === "readback") {
        const rp = payload as unknown as ReadbackTaskPayload;
        if (!Number.isInteger(rp.publishJobId) || rp.publishJobId <= 0 || typeof rp.title !== "string" || !rp.title.trim() || !Number.isFinite(rp.publishedAt)) return { error: "invalid readback task payload", code: 400 as const };
        await tx.execute(sql`SELECT id FROM publish_jobs WHERE id = ${rp.publishJobId} AND user_id = ${userId} FOR UPDATE`);
        const [publication] = await tx.select().from(publishJobs).where(and(eq(publishJobs.id, rp.publishJobId), eq(publishJobs.userId, userId), eq(publishJobs.status, "done")));
        if (!publication) return { error: "readback publication not found or not reported", code: 400 as const };
        const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, publication.accountId), eq(hostedAccounts.userId, userId)));
        if (!account || (rp.xhsUserId && rp.xhsUserId !== account.xhsUserId)) return { error: "readback account mismatch", code: 400 as const };
        const readbackData = p.status === "done" ? postedDataSchema.safeParse(p.data ?? (p.outcome === "login_required" || p.outcome === "readback_error" ? { items: [] } : null)) : null;
        if (readbackData && !readbackData.success) return { error: "invalid readback result data", code: 400 as const };
        // Another historic readback cannot downgrade verified evidence or reschedule its metrics.
        if (publication.outcome !== "verified") {
          const tries = typeof payload.attempts === "number" && Number.isInteger(payload.attempts) && payload.attempts >= 0 ? payload.attempts : 0;
          if (p.status === "failed") {
            rescheduled = tries + 1 < READBACK_MAX_ATTEMPTS;
            if (rescheduled) await tx.update(jobs).set({ status: "pending", claimedBy: null, claimedAt: null, leaseId: null, leaseUntil: null, dueAt: new Date(now.getTime() + 10 * MIN), payload: { ...payload, attempts: tries + 1 }, error: p.error ?? null }).where(eq(jobs.id, id));
            else await tx.update(publishJobs).set({ outcome: "readback_error", updatedAt: now }).where(eq(publishJobs.id, publication.id));
            ack = { ok: true, rescheduled };
          } else {
            const items = readbackData && readbackData.success ? readbackData.data.items : [];
            const match = matchPostedNote(items.filter(i => !!i.noteId), rp.title, rp.publishedAt);
            const outcome: PublishOutcome = p.outcome === "login_required" ? "login_required" : match ? "verified" : items.length ? "unverified" : p.outcome === "unverified" ? "unverified" : "readback_error";
            rescheduled = outcome === "unverified" && tries + 1 < READBACK_MAX_ATTEMPTS;
            if (rescheduled) {
              await tx.update(jobs).set({ status: "pending", claimedBy: null, claimedAt: null, leaseId: null, leaseUntil: null, dueAt: new Date(now.getTime() + 30 * MIN), payload: { ...payload, attempts: tries + 1 }, error: null }).where(eq(jobs.id, id));
              ack = { ok: true, rescheduled: true };
            } else {
              const publishedAt = match?.publishTime === undefined ? null : new Date(match.publishTime);
              await tx.update(publishJobs).set({ outcome, noteId: match?.noteId ?? null, resultUrl: match?.url ?? publication.resultUrl, verifiedAt: outcome === "verified" ? now : null,
                ...(publishedAt && Number.isFinite(publishedAt.getTime()) && publishedAt.getTime() > 0 && publishedAt.getTime() <= now.getTime() ? { publishedAt } : {}), updatedAt: now }).where(eq(publishJobs.id, publication.id));
              if (outcome === "verified" && match?.noteId) await scheduleMetricsTasks(scoped, userId, { publishJobId: publication.id, noteId: match.noteId, xhsUserId: account.xhsUserId, noteUrl: match.url }, now);
            }
          }
        }
      } else if (job.type === "metrics") {
        const mp = payload as unknown as MetricsTaskPayload;
        if (!Number.isInteger(mp.publishJobId) || mp.publishJobId <= 0 || typeof mp.noteId !== "string" || !mp.noteId.trim()) return { error: "invalid metrics task payload", code: 400 as const };
        const [publication] = await tx.select().from(publishJobs).where(and(eq(publishJobs.id, Number(mp.publishJobId) || 0), eq(publishJobs.userId, userId)));
        if (!publication || !mp.noteId || publication.noteId !== mp.noteId || publication.status !== "done") return { error: "metrics publication/note mismatch", code: 400 as const };
        const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, publication.accountId), eq(hostedAccounts.userId, userId)));
        if (!account || (mp.xhsUserId && mp.xhsUserId !== account.xhsUserId)) return { error: "metrics account mismatch", code: 400 as const };
        if (p.status === "done") {
          const data = metricsDataSchema.safeParse(p.data); if (!data.success) return { error: "invalid metrics result data", code: 400 as const };
          const d = data.data, rows = d.rows?.length ? d.rows : [{ ...d, noteId: d.noteId! }];
          if (rows.some(r => r.noteId !== mp.noteId) || rows.length !== 1 || (d.noteId && d.noteId !== mp.noteId)) return { error: "metrics rows must match the task note", code: 400 as const };
          const r = rows[0]!;
          await tx.insert(noteMetrics).values({ userId, publishJobId: publication.id, noteId: mp.noteId, capturedAt: now,
            noteUrl: r.url ?? (typeof d.extra?.noteUrl === "string" ? d.extra.noteUrl : mp.noteUrl), views: metricNumber(r.views), likes: metricNumber(r.likes), collects: metricNumber(r.collects), comments: metricNumber(r.comments), shares: metricNumber(r.shares), exposure: metricNumber(r.exposure),
            extra: { ...(d.extra ?? {}), taskId: id, scheduledFor: job.dueAt?.toISOString() ?? null, source: typeof d.extra?.source === "string" ? d.extra.source : "browser_readback" } });
        }
      } else {
        const sp = payload as unknown as AccountSnapshotTaskPayload;
        if (!Number.isInteger(sp.accountId) || sp.accountId <= 0) return { error: "invalid snapshot task payload", code: 400 as const };
        const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, Number(sp.accountId) || 0), eq(hostedAccounts.userId, userId)));
        if (!account || (sp.xhsUserId && sp.xhsUserId !== account.xhsUserId)) return { error: "snapshot account not owned or mismatched", code: 400 as const };
        if (p.status === "done") {
          const data = snapshotDataSchema.safeParse(p.data); if (!data.success) return { error: "invalid snapshot result data", code: 400 as const };
          await tx.insert(accountSnapshots).values({ userId, accountId: account.id, capturedAt: now, followers: metricNumber(data.data.followers), likesTotal: metricNumber(data.data.likesTotal), notesCount: metricNumber(data.data.notesCount), extra: data.data.extra ?? null });
        }
      }
      if (!rescheduled) await tx.update(jobs).set({ status: p.status, error: p.error ?? null, finishedAt: now, leaseUntil: null }).where(eq(jobs.id, id));
      await saveReceipt(tx, userId, "tasks", id, p.receiptId, hash, ack); return { ack };
    });
    return "error" in result ? c.json({ error: result.error }, result.code) : c.json(result.ack);
  });
  return app;
}
