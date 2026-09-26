import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, collections, drafts, hostedAccounts, publishJobs, topics } from "../db/schema";
import { persistCollectedMedia, publicBase } from "../lib/media-store";

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
const commentSchema = z.object({
  commentId: z.string().default(""),
  userName: z.string().default(""),
  nickname: z.string().default(""),
  avatar: z.string().default(""),
  content: z.string().default(""),
  likes: z.number().default(0),
  subComments: z.array(z.object({ content: z.string() })).optional(),
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
      } else {
        await deps.db.insert(hostedAccounts).values({
          userId,
          platform: "xhs",
          subType: acc.subType,
          xhsUserId: acc.xhsUserId,
          nickname: acc.nickname,
          avatar: acc.avatar,
          status: acc.status,
          statusMessage: acc.statusMessage ?? "",
          lastSeenAt: now,
        });
      }
    }
    return c.json({ ok: true });
  });

  /** 卡片批量 upsert；details 里同 noteId 的详情/评论落到对应行。 */
  app.post("/collect", async (c) => {
    const userId = c.get("userId");
    const parsed = collectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
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
        likes: item.likes,
        collects: item.collects,
        comments: item.comments,
        shares: item.shares,
        tags: detail?.tags ?? [],
        commentsData: (detail?.commentsData ?? []).map((cm) => ({
          commentId: cm.commentId,
          userName: cm.userName || cm.nickname,
          avatar: cm.avatar,
          content: cm.content,
          likes: cm.likes,
          subComments: cm.subComments ?? [],
        })),
        source: p.source,
        sourceUrl: p.context?.pageUrl || item.url,
        // 搜索场景的关键词归因（context.keyword 由插件从页面 URL 提取）
        sourceKeyword: p.context?.keyword ?? "",
        publishedAt,
        ipLocation: detail?.ipLocation || "",
        rawJson: null as any,
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
              // 详情重传可能不带评论（嗅探时机），空数组不覆盖已有评论
              commentsData: values.commentsData.length
                ? values.commentsData
                : existing.commentsData,
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
    void persistCollectedMedia(deps, ids, publicBase(c.req)).catch(() => {});
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
          title: r.draft.title,
          content: r.draft.content,
          tags: r.draft.tags,
          images: r.draft.images,
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
        title: r.draft.title,
        content: r.draft.content,
        tags: r.draft.tags,
        images: r.draft.images,
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
    }
    return c.json({ ok: true });
  });

  return app;
}
