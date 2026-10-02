import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { mergeComments } from "@v2media/shared";
import type { Deps } from "../context";
import { collectedNotes, collections } from "../db/schema";
import { enqueueMediaJob } from "./media-jobs";
import { assertWritable } from "./runtime-policy";

const commentExtras = { createdAt: z.number().optional(), ipLocation: z.string().optional(), pictures: z.array(z.string()).optional(),
  isAuthor: z.boolean().optional(), subCommentCount: z.number().optional() };

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

export const cardSchema = z.object({
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

export const detailSchema = cardSchema.extend({
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
export const collectSchema = z.object({
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


export async function ingestCollect(deps: Deps, userId: number, raw: unknown, base: string) {
  assertWritable(deps);
    const parsed = collectSchema.safeParse(raw);
    if (!parsed.success) {
      // 说清楚是哪个字段不合格：否则插件那边只会静默失败，笔记整条采不进来
      const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`);
      console.warn("ext collect rejected:", issues);
      return { error: "bad payload", issues, code: 400 as const };
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
      if (!col) return { error: "collection not found", code: 400 as const };
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
    await enqueueMediaJob(deps, userId, ids, base);
    return { saved: ids.length, ids };
}
