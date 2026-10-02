import { and, asc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { mergeComments } from "@v2media/shared";

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
import { enqueueMediaJob } from "../lib/media-jobs";

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

// 解析器产出 userName（packages/shared/xhs-parse），兼容旧的 nickname 字段名
const commentExtras = {
  createdAt: z.number().optional(),
  ipLocation: z.string().optional(),
  pictures: z.array(z.string()).optional(),
  isAuthor: z.boolean().optional(),
  subCommentCount: z.number().optional(),
};
const commentSchema = z.object({
  ...commentExtras,
  commentId: z.string().default(""),
  userName: z.string().default(""),
  nickname: z.string().default(""),
  avatar: z.string().default(""),
  userId: z.string().optional(),
  content: z.string().default(""),
  likes: z.number().default(0),
  subComments: z.array(z.object({
    commentId: z.string().default(""), userName: z.string().default(""),
    userId: z.string().optional(), avatar: z.string().default(""),
    content: z.string(), likes: z.number().default(0),
    ...commentExtras,
  })).optional(),
});

const cardSchema = z.object({
  noteId: z.string(),
  xsecToken: z.string().default(""),
  type: z.enum(["video", "image", "unknown"]).default("image"),
  title: z.string().default(""),
  desc: z.string().default(""),
  author: z
    .object({ userId: z.string().default(""), nickname: z.string().default(""), avatar: z.string().default("") })
    .default({ userId: "", nickname: "", avatar: "" }),
  cover: z.string().default(""),
  likes: z.number().default(0),
  collects: z.number().default(0),
  comments: z.number().default(0),
  shares: z.number().default(0),
  url: z.string().default(""),
});

const detailSchema = cardSchema.extend({
  content: z.string().default(""),
  tags: z.array(z.string()).default([]),
  images: z.array(z.object({ url: z.string() })).default([]),
  videoUrl: z.string().optional(),
  video: z
    .object({
      durationMs: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      fps: z.number().optional(),
      size: z.number().optional(),
      format: z.string().optional(),
      videoCodec: z.string().optional(),
      bitrate: z.number().optional(),
      quality: z.string().optional(),
      videoId: z.string().optional(),
      fallbackUrls: z.array(z.string()).max(3).optional(),
    })
    .optional(),
  commentsData: z.array(commentSchema).optional(),
  // 发布时间戳（毫秒）/ IP 属地 —— 详情页才有，分析时效判断靠它
  publishedAt: z.string().optional(),
  ipLocation: z.string().default(""),
});

/** CollectBatch（packages/shared/types.ts）。 */
const collectSchema = z.object({
  source: z.string().default("homefeed"),
  context: z
    .object({
      keyword: z.string().optional(),
      authorId: z.string().optional(),
      pageUrl: z.string().optional(),
    })
    .optional(),
  collectionId: z.number().int().positive().nullish(),
  items: z.array(cardSchema),
  details: z.array(detailSchema).optional(),
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
  app.post("/collect", async (c) => {
    const userId = c.get("userId");
    const parsed = collectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      // 说清楚是哪个字段不合格：否则插件那边只会静默失败，笔记整条采不进来
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
      console.warn("ext collect rejected:", issues);
      return c.json({ error: "bad payload", issues }, 400);
    }
    const p = parsed.data;
    // collectionId 三态：undefined=老客户端不动分组；null=显式不分组；number=归库（校验归属）
    const hasCollection = p.collectionId !== undefined;
    let collectionId: number | null = null;
    if (hasCollection && p.collectionId != null) {
      const [col] = await deps.db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.id, p.collectionId), eq(collections.userId, userId)))
        .limit(1);
      if (!col) return c.json({ error: "collection not found" }, 400);
      collectionId = col.id;
    }
    const detailMap = new Map(p.details?.map((d) => [d.noteId, d]) ?? []);
    const cardMap = new Map(p.items.map((i) => [i.noteId, i]));
    // detail-only 批（单篇采集）也要落库：detailSchema 含全部卡片字段
    const noteIds = new Set([...cardMap.keys(), ...detailMap.keys()]);
    const ids: number[] = [];
    for (const noteId of noteIds) {
      const detail = detailMap.get(noteId);
      const item = cardMap.get(noteId) ?? detail!;
      // 真标题 = 卡片或详情里抓到的；拿不到时用正文前 30 字兜底并打 titleFallback 标记，
      // 之后真标题到了仍可以把它换掉
      const realTitle = item.title || detail?.title || "";
      // publishedAt 可能是超出 Date 范围的乱值 —— 转换后再校验，坏值按未采集处理
      const pubDate = detail?.publishedAt ? new Date(+detail.publishedAt) : null;
      const publishedAt = pubDate && Number.isFinite(pubDate.getTime()) && pubDate.getTime() > 0 ? pubDate : null;
      const values = {
        userId,
        // 未显式传（老客户端）时新行也不分组
        collectionId: collectionId,
        noteId: item.noteId,
        type: item.type === "unknown" ? "image" : item.type,
        title: realTitle || (detail?.content || item.desc || "").slice(0, 30) || "(无标题)",
        titleFallback: !realTitle,
        hasDetail: !!detail,
        content: detail?.content || item.desc || item.title,
        authorName: item.author.nickname,
        authorId: item.author.userId,
        cover: item.cover,
        images: detail?.images?.length ? detail.images : [{ url: item.cover }].filter((i) => i.url),
        videoUrl: detail?.videoUrl ?? null,
        // 同批详情比列表卡片完整，不能让卡片缺省的 0 覆盖真实互动数。
        likes: detail?.likes ?? item.likes,
        collects: detail?.collects ?? item.collects,
        comments: detail?.comments ?? item.comments,
        shares: detail?.shares ?? item.shares,
        tags: detail?.tags ?? [],
        commentsData: (detail?.commentsData ?? []).map((cm) => ({
          commentId: cm.commentId,
          userName: cm.userName || cm.nickname,
          userId: cm.userId,
          avatar: cm.avatar,
          content: cm.content,
          likes: cm.likes,
          createdAt: cm.createdAt,
          ipLocation: cm.ipLocation,
          pictures: cm.pictures,
          isAuthor: cm.isAuthor,
          subCommentCount: cm.subCommentCount,
          subComments: cm.subComments ?? [],
        })),
        source: p.source,
        // 原笔记链接必须是笔记自身 URL（item.url 恒为 explore/<id> 形态）；
        // context.pageUrl 只是采集发生的页面（feed 列表地址会让「原笔记」失效）
        sourceUrl: item.url || p.context?.pageUrl || "",
        // 搜索场景的关键词归因（context.keyword 由插件从页面 URL 提取）
        sourceKeyword: p.context?.keyword ?? "",
        publishedAt,
        ipLocation: detail?.ipLocation || "",
        // 视频时长/分辨率/大小等不单开列，放 raw_json.video（免迁移）
        rawJson: {
          authorAvatar: detail?.author.avatar || item.author.avatar || "",
          ...(detail?.video ? { video: detail.video } : {}),
        },
      };
      const [existing] = await deps.db
        .select()
        .from(collectedNotes)
        .where(and(eq(collectedNotes.userId, userId), eq(collectedNotes.noteId, item.noteId)))
        .limit(1);
      if (existing) {
        // 纯卡片批次不覆盖详情级字段（正文/图集/视频/标签/评论），已入库的值一律优先
        const merged = detail
          ? {
              ...values,
              title: realTitle || existing.title || values.title,
              titleFallback: !realTitle && existing.titleFallback,
              hasDetail: true,
              // SSR/补评论重传可能只有部分详情，不能清空已采到的正文与素材。
              content: detail.content || item.desc || existing.content || values.content,
              cover: values.cover || existing.cover,
              images: detail.images.length || !existing.images.length ? values.images : existing.images,
              videoUrl: values.videoUrl || existing.videoUrl,
              tags: values.tags.length ? values.tags : existing.tags,
              // 详情重传可能不带评论（嗅探时机），空数组不覆盖已有评论
              commentsData: mergeComments(
                existing.commentsData as typeof values.commentsData, values.commentsData,
              ),
              publishedAt: values.publishedAt ?? existing.publishedAt,
              ipLocation: values.ipLocation || existing.ipLocation,
              sourceKeyword: values.sourceKeyword || existing.sourceKeyword,
            }
          : {
              ...values,
              title: realTitle || existing.title,
              titleFallback: existing.titleFallback && !realTitle,
              hasDetail: existing.hasDetail,
              content: existing.content || values.content,
              images: existing.images.length ? existing.images : values.images,
              videoUrl: existing.videoUrl ?? values.videoUrl,
              tags: existing.tags.length ? existing.tags : values.tags,
              commentsData: existing.commentsData.length ? existing.commentsData : values.commentsData,
              sourceKeyword: values.sourceKeyword || existing.sourceKeyword,
              // 发布时间/IP 属地只有详情才有，卡片批次不覆盖
              publishedAt: existing.publishedAt,
              ipLocation: existing.ipLocation,
            };
        merged.rawJson = {
          ...(existing.rawJson as Record<string, unknown> ?? {}),
          authorAvatar: values.rawJson.authorAvatar ||
            (existing.rawJson as { authorAvatar?: string } | null)?.authorAvatar || "",
          // 卡片批次不带 video，不能把已采到的元信息抹掉
          ...(values.rawJson.video ? { video: values.rawJson.video } : {}),
        };
        await deps.db
          .update(collectedNotes)
          // collectionId 显式传了才改分组（含 null=移回未分组）；缺省不动原分组
          .set({
            ...merged,
            savedAt: deps.now(),
            ...(hasCollection ? { collectionId } : {}),
          })
          .where(eq(collectedNotes.id, existing.id));
        ids.push(existing.id);
      } else {
        const [row] = await deps.db.insert(collectedNotes).values(values).returning({ id: collectedNotes.id });
        ids.push(row!.id);
      }
    }
    // 后台把 xhscdn 图转存 R2 并回写（不占采集响应时间；失败降级保留原图床链接）
    await enqueueMediaJob(deps, userId, ids, publicBase(c.req));
    return c.json({ saved: ids.length, ids });
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
      .where(and(eq(jobs.id, id), eq(jobs.userId, userId), eq(jobs.status, "pending")))
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
        const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
        await deps.db.insert(noteMetrics).values({
          userId,
          publishJobId: pj.id,
          noteId,
          noteUrl: typeof r.url === "string" ? r.url : (d.extra as Record<string, unknown>)?.noteUrl as string | undefined,
          views: num(r.views),
          likes: num(r.likes),
          collects: num(r.collects),
          comments: num(r.comments),
          shares: num(r.shares),
          exposure: num(r.exposure),
          extra: (d.extra ?? null) as Record<string, unknown> | null,
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
