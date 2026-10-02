import { and, asc, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ingestCollect } from "../lib/collect-ingest";

import type {
  AccountSnapshotTaskPayload,
  MetricsTaskPayload,
  PostedNoteItem,
  PublishOutcome,
  ReadbackTaskPayload,
} from "@v2media/shared";
import type { Deps } from "../context";
import {
  accountSnapshots,
  collectedNotes,
  collections,
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
/** running 超过该时长无回执 → 回收重排（执行方掉线）。 */
const TASK_STALE_MS = 30 * MIN;
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
  accounts: z.array(
    z.object({
      xhsUserId: z.string().default(""),
      nickname: z.string().default(""),
      avatar: z.string().default(""),
      subType: z.enum(["pc", "creator"]).default("pc"),
      status: z.enum(["online", "expired"]).default("online"),
      statusMessage: z.string().optional(),
    }),
  ),
});

const claimSchema = z.object({ claimedBy: z.string().default("ext") });
const resultSchema = z.object({
  status: z.enum(["done", "failed"]),
  resultUrl: z.string().optional(),
  error: z.string().optional(),
});

export function extModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.post("/accounts/heartbeat", async (c) => {
    const userId = c.get("userId");
    const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad heartbeat" }, 400);
    const now = deps.now();
    for (const acc of parsed.data.accounts) {
      const [existing] = await deps.db
        .select()
        .from(hostedAccounts)
        .where(
          and(
            eq(hostedAccounts.userId, userId),
            eq(hostedAccounts.platform, "xhs"),
            eq(hostedAccounts.subType, acc.subType),
            eq(hostedAccounts.xhsUserId, acc.xhsUserId),
          ),
        )
        .limit(1);
      if (existing) {
        await deps.db
          .update(hostedAccounts)
          .set({
            nickname: acc.nickname || existing.nickname,
            avatar: acc.avatar || existing.avatar,
            status: acc.status,
            statusMessage: acc.statusMessage ?? "",
            lastSeenAt: now,
          })
          .where(eq(hostedAccounts.id, existing.id));
        // 在线账号每日补一次概览快照（无排队任务且 20h 内无快照才排）
        if (acc.status === "online") {
          await ensureSnapshotTask(deps, userId, existing.id, acc.xhsUserId);
        }
      } else {
        const [row] = await deps.db
          .insert(hostedAccounts)
          .values({
            userId,
            platform: "xhs",
            subType: acc.subType,
            xhsUserId: acc.xhsUserId,
            nickname: acc.nickname,
            avatar: acc.avatar,
            status: acc.status,
            statusMessage: acc.statusMessage ?? "",
            lastSeenAt: now,
          })
          .returning({ id: hostedAccounts.id });
        if (row && acc.status === "online") {
          await ensureSnapshotTask(deps, userId, row.id, acc.xhsUserId);
        }
      }
    }
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

  /** 单个任务的草稿全文 —— SW 重启后 trackedJobs 丢失时靠它恢复已认领任务。
      running 任务只回给原认领方（?claimer=SW_ID），防另一浏览器重复执行。 */
  app.get("/publish/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const claimer = c.req.query("claimer") ?? "";
    const [r] = await deps.db
      .select({ job: publishJobs, draft: drafts, account: hostedAccounts })
      .from(publishJobs)
      .innerJoin(drafts, eq(publishJobs.draftId, drafts.id))
      .leftJoin(hostedAccounts, eq(publishJobs.accountId, hostedAccounts.id))
      .where(
        and(
          eq(publishJobs.id, id),
          eq(publishJobs.userId, userId),
          or(
            eq(publishJobs.status, "pending"),
            and(eq(publishJobs.status, "running"), eq(publishJobs.claimedBy, claimer)),
          ),
        ),
      )
      .limit(1);
    if (!r) return c.json({ error: "not found" }, 404);
    return c.json({
      ...r.job,
      scheduledAt: r.job.scheduledAt?.getTime(),
      xhsUserId: r.account?.xhsUserId ?? "",
      draft: {
        ...(r.job.draftSnapshot ?? { title: r.draft.title, content: r.draft.content, tags: r.draft.tags, images: r.draft.images }),
      },
    });
  });

  app.post("/publish/:id/claim", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(publishJobs)
      .set({ status: "running", claimedBy: parsed.data.claimedBy, updatedAt: deps.now() })
      .where(
        and(eq(publishJobs.id, id), eq(publishJobs.userId, userId), eq(publishJobs.status, "pending")),
      )
      .returning();
    if (!row) return c.json({ error: "not found or already claimed" }, 404);
    return c.json(row);
  });

  app.post("/publish/:id/result", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const parsed = resultSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(publishJobs)
      .set({
        status: parsed.data.status,
        ...(parsed.data.status === "done" ? { reportedAt: deps.now() } : {}),
        resultUrl: parsed.data.resultUrl,
        error: parsed.data.error,
        updatedAt: deps.now(),
      })
      .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    if (parsed.data.status === "done") {
      await deps.db
        .update(drafts)
        .set({ status: "published", updatedAt: deps.now() })
        .where(eq(drafts.id, row.draftId));
      // 串联选题池：该草稿若来自选题，回填 published + publishJobId（归因关联点）
      await deps.db
        .update(topics)
        .set({ status: "published", publishJobId: row.id, updatedAt: deps.now() })
        .where(and(eq(topics.draftId, row.draftId), eq(topics.userId, userId)));
      // 归因调度：10min 后回创作中心读回对账（拿真实 noteId + outcome）
      const [draft] = await deps.db
        .select({ title: drafts.title })
        .from(drafts)
        .where(eq(drafts.id, row.draftId))
        .limit(1);
      const [account] = await deps.db
        .select({ xhsUserId: hostedAccounts.xhsUserId })
        .from(hostedAccounts)
        .where(eq(hostedAccounts.id, row.accountId))
        .limit(1);
      await scheduleTask(
        deps,
        userId,
        "readback",
        {
          publishJobId: row.id,
          title: row.draftSnapshot?.title ?? draft?.title ?? "",
          xhsUserId: account?.xhsUserId ?? "",
          publishedAt: deps.now().getTime(),
        } satisfies ReadbackTaskPayload,
        new Date(deps.now().getTime() + 10 * MIN),
      );
    }
    return c.json({ ok: true });
  });

  // ---------- 归因任务端点（插件轮询→认领→回报） ----------

  /** 到期任务列表：pending 且 dueAt<=now（或无期）；顺带回收超时的 running。 */
  app.get("/tasks/pending", async (c) => {
    const userId = c.get("userId");
    const limit = Math.min(Number(c.req.query("limit")) || 5, 20);
    const now = deps.now();
    // 回收掉线执行方的 running 任务（claimedAt 超 30min）
    await deps.db
      .update(jobs)
      .set({ status: "pending", claimedBy: null, claimedAt: null })
      .where(
        and(
          eq(jobs.userId, userId),
          eq(jobs.status, "running"),
          inArray(jobs.type, ["readback", "metrics", "account_snapshot"]),
          or(isNull(jobs.claimedAt), lt(jobs.claimedAt, new Date(now.getTime() - TASK_STALE_MS))),
        ),
      );
    const rows = await deps.db
      .select({ id: jobs.id, type: jobs.type, payload: jobs.payload })
      .from(jobs)
      .where(
        and(
          eq(jobs.userId, userId),
          eq(jobs.status, "pending"),
          inArray(jobs.type, ["readback", "metrics", "account_snapshot"]),
          or(isNull(jobs.dueAt), lte(jobs.dueAt, now)),
        ),
      )
      .orderBy(asc(jobs.dueAt), asc(jobs.id))
      .limit(limit);
    return c.json({ tasks: rows });
  });

  app.post("/tasks/:id/claim", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const parsed = z
      .object({ claimedBy: z.string().default("ext") })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(jobs)
      .set({ status: "running", claimedBy: parsed.data.claimedBy, claimedAt: deps.now() })
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId), eq(jobs.status, "pending"), inArray(jobs.type, ["readback", "metrics", "account_snapshot"])))
      .returning();
    if (!row) return c.json({ error: "not found or already claimed" }, 404);
    return c.json(row);
  });

  /** 任务回报：readback 回传已发列表做服务端匹配；metrics/snapshot 直接落库。 */
  app.post("/tasks/:id/result", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const parsed = z
      .object({
        status: z.enum(["done", "failed"]),
        outcome: z
          .enum(["verified", "unverified", "login_required", "readback_error"])
          .optional(),
        error: z.string().optional(),
        data: z.any().optional(),
      })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [job] = await deps.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId)))
      .limit(1);
    if (!job) return c.json({ error: "not found" }, 404);
    if (!["readback", "metrics", "account_snapshot"].includes(job.type)) return c.json({ error: "server task cannot be completed by extension" }, 400);
    const now = deps.now();
    const { status, data } = parsed.data;
    const payload = (job.payload ?? {}) as Record<string, unknown>;

    if (job.type === "readback") {
      const p = payload as unknown as ReadbackTaskPayload;
      if (status === "failed") {
        // 掉线/超时重排（上限 3 次），仍失败则 outcome=readback_error
        const attempts = Number(payload.attempts ?? 0) + 1;
        if (attempts < READBACK_MAX_ATTEMPTS) {
          await deps.db
            .update(jobs)
            .set({
              status: "pending",
              claimedBy: null,
              claimedAt: null,
              dueAt: new Date(now.getTime() + 10 * MIN), // 失败退避 10min
              payload: { ...payload, attempts },
              error: parsed.data.error ?? null,
            })
            .where(eq(jobs.id, job.id));
        } else {
          await deps.db
            .update(jobs)
            .set({ status: "failed", error: parsed.data.error ?? "readback 重试耗尽", finishedAt: now })
            .where(eq(jobs.id, job.id));
          await deps.db
            .update(publishJobs)
            .set({ outcome: "readback_error", updatedAt: now })
            .where(and(eq(publishJobs.id, p.publishJobId), eq(publishJobs.userId, userId)));
        }
        return c.json({ ok: true, rescheduled: attempts < READBACK_MAX_ATTEMPTS });
      }
      const items = ((data as { items?: PostedNoteItem[] } | undefined)?.items ?? []) as PostedNoteItem[];
      const match = matchPostedNote(items, p.title ?? "", p.publishedAt ?? 0);
      const attempts = Number(payload.attempts ?? 0);
      const outcome: PublishOutcome =
        parsed.data.outcome === "login_required"
          ? "login_required"
          : match
            ? "verified"
            : items.length
              ? "unverified"
              : (parsed.data.outcome ?? "readback_error");
      // unverified 可能只是还没过审/列表未刷新——再排一次 30min 后复读，耗尽才定档
      if (outcome === "unverified" && attempts + 1 < READBACK_MAX_ATTEMPTS) {
        await deps.db
          .update(jobs)
          .set({
            status: "pending",
            claimedBy: null,
            claimedAt: null,
            dueAt: new Date(now.getTime() + 30 * MIN),
            payload: { ...payload, attempts: attempts + 1 },
          })
          .where(eq(jobs.id, job.id));
        return c.json({ ok: true, rescheduled: true });
      }
      await deps.db
        .update(publishJobs)
        .set({
          outcome,
          ...(outcome === "verified" && match?.publishTime && Number.isFinite(new Date(match.publishTime).getTime())
            && new Date(match.publishTime).getTime() > 0 && new Date(match.publishTime).getTime() <= now.getTime()
            ? { publishedAt: new Date(match.publishTime) } : {}),
          noteId: match?.noteId ?? null,
          resultUrl: match?.url ?? undefined,
          verifiedAt: outcome === "verified" ? now : null,
          updatedAt: now,
        })
        .where(and(eq(publishJobs.id, p.publishJobId), eq(publishJobs.userId, userId)));
      if (outcome === "verified" && match?.noteId) {
        await scheduleMetricsTasks(
          deps,
          userId,
          {
            publishJobId: p.publishJobId,
            noteId: match.noteId,
            xhsUserId: p.xhsUserId,
            noteUrl: match.url,
          },
          now,
        );
      }
    } else if (job.type === "metrics" && status === "done") {
      const d = (data ?? {}) as {
        noteId?: string;
        rows?: Array<Record<string, unknown>>;
        extra?: Record<string, unknown>;
      };
      const rows: Array<Record<string, unknown>> = d.rows?.length
        ? d.rows
        : d.noteId
          ? [d as Record<string, unknown>]
          : [];
      for (const r of rows) {
        const noteId = typeof r.noteId === "string" ? r.noteId : "";
        if (!noteId) continue;
        // 只记本用户的已发笔记（payload 指定则单篇；否则落全部已确认 noteId 的行）
        const [pj] = await deps.db
          .select({ id: publishJobs.id })
          .from(publishJobs)
          .where(and(eq(publishJobs.noteId, noteId), eq(publishJobs.userId, userId)))
          .limit(1);
        if (!pj) continue;
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2_147_483_647 ? Math.round(v) : null);
        await deps.db.insert(noteMetrics).values({
          userId,
          publishJobId: pj.id,
          noteId,
          capturedAt: now,
          noteUrl: typeof r.url === "string" ? r.url : (d.extra as Record<string, unknown>)?.noteUrl as string | undefined,
          views: num(r.views),
          likes: num(r.likes),
          collects: num(r.collects),
          comments: num(r.comments),
          shares: num(r.shares),
          exposure: num(r.exposure),
          extra: { ...(d.extra ?? {}), taskId: job.id, scheduledFor: job.dueAt?.toISOString() ?? null,
            source: typeof d.extra?.source === "string" ? d.extra.source : "browser_readback" },
        });
      }
    } else if (job.type === "account_snapshot" && status === "done") {
      const p = payload as unknown as AccountSnapshotTaskPayload;
      const d = (data ?? {}) as {
        followers?: number; likesTotal?: number; notesCount?: number; extra?: Record<string, unknown>;
      };
      await deps.db.insert(accountSnapshots).values({
        userId,
        accountId: typeof p.accountId === "number" ? p.accountId : null,
        followers: d.followers ?? null,
        likesTotal: d.likesTotal ?? null,
        notesCount: d.notesCount ?? null,
        extra: d.extra ?? null,
      });
    }

    await deps.db
      .update(jobs)
      .set({ status, error: parsed.data.error ?? null, finishedAt: now })
      .where(eq(jobs.id, job.id));
    return c.json({ ok: true });
  });

  return app;
}
