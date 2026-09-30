/**
 * 小红书页面数据解析器。
 *
 * 输入来源（全部是站点自己签名拿到的数据，见 docs/xhs-extension-research.md）：
 *  1. window.__INITIAL_STATE__ —— Vue3 reactive 包装，数组字段需解 ._rawValue
 *  2. XHR/fetch 嗅探到的 edith.xiaohongshu.com API 响应
 *
 * 纯函数，不依赖 DOM —— 可在插件、服务端、单测三处复用。
 */

import type { CollectSource, NoteCard, NoteComment, NoteDetail, NoteImage } from "./types";

type Any = Record<string, any>;

/** Vue3 ref/reactive 解包：{ _rawValue: x } -> x（递归数组友好）。 */
export function unwrap<T = any>(v: any): T {
  if (v && typeof v === "object" && "_rawValue" in v) return v._rawValue as T;
  return v as T;
}

const num = (v: any): number => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    // 小红书有时返回 "1.2万" 这类中文计数
    const w = v.trim();
    if (w.endsWith("万")) return Math.round(parseFloat(w) * 10000) || 0;
    const n = parseInt(w, 10);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
};

const str = (v: any): string => (v == null ? "" : String(v));

/** 平台有时返回 HTTP CDN 地址，统一升级已知小红书媒体域，供 HTTPS 代理与转存使用。 */
export function normalizeXhsMediaUrl(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol === "http:" && /(^|\.)xhscdn\.com$|(^|\.)xiaohongshu\.com$/.test(url.hostname)) {
      url.protocol = "https:";
      return url.href;
    }
  } catch { /* 非 URL 保留给调用方处理。 */ }
  return value;
}

const imageUrl = (image: Any | string | undefined): string => normalizeXhsMediaUrl(
  typeof image === "string" ? image : str(image?.url_default || image?.urlDefault ||
    image?.url_pre || image?.urlPre || image?.url ||
    image?.info_list?.find((x: Any) => x?.url)?.url || image?.infoList?.find((x: Any) => x?.url)?.url || ""),
);

/** SSR 是 JSON 加裸 undefined/空 Map、Set；仅替换字符串外的已知字面量，不执行页面脚本。 */
export function xhsInitialStateFromHtml(html: string): Any | null {
  const start = html.indexOf("__INITIAL_STATE__");
  if (start < 0) return null;
  const eq = html.indexOf("=", start), end = html.indexOf("</script>", eq);
  if (eq < 0 || end < 0) return null;
  const raw = html.slice(eq + 1, end).trim().replace(/;$/, "");
  let output = "", quoted = false, escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]!;
    if (!quoted) {
      const token = /^(undefined\b|new\s+(Map|Set)\(\s*\[\s*\]\s*\))/.exec(raw.slice(i));
      if (token) {
        output += token[1] === "undefined" ? "null" : token[2] === "Map" ? "{}" : "[]";
        i += token[0].length - 1;
        continue;
      }
    }
    output += char;
    if (quoted && escaped) escaped = false;
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"') quoted = !quoted;
  }
  try { return JSON.parse(output) as Any; } catch { return null; }
}

export function noteUrl(noteId: string, xsecToken = "", xsecSource = "pc_search"): string {
  const q = xsecToken
    ? `?xsec_token=${encodeURIComponent(xsecToken)}&xsec_source=${xsecSource}`
    : "";
  return `https://www.xiaohongshu.com/explore/${noteId}${q}`;
}

/** 搜索/feed item -> NoteCard。item 形状见 docs/xhs-extension-research.md。 */
export function noteCardFromItem(item: Any, source: CollectSource): NoteCard | null {
  const card = item?.note_card ?? item?.noteCard;
  if (!card) return null;
  const noteId = str(item.id ?? item.note_id ?? item.noteId ?? card.note_id ?? card.noteId);
  if (!noteId) return null;
  const user = card.user ?? {};
  const ii = card.interact_info ?? card.interactInfo ?? {};
  const cover = card.cover ?? {};
  const xsecToken = str(item.xsec_token || item.xsecToken || "");
  return {
    noteId,
    xsecToken,
    type: card.type === "video" ? "video" : "image",
    title: str(card.display_title || card.displayTitle || card.title),
    desc: str(card.desc),
    author: {
      userId: str(user.user_id ?? user.userId ?? ""),
      nickname: str(user.nickname ?? user.nickName ?? user.nick_name ?? ""),
      avatar: normalizeXhsMediaUrl(str(user.avatar ?? user.image ?? "")),
    },
    cover: imageUrl(cover),
    likes: num(ii.liked_count ?? ii.likedCount),
    collects: num(ii.collected_count ?? ii.collectedCount),
    comments: num(ii.comment_count ?? ii.commentCount),
    shares: num(ii.share_count ?? ii.shareCount),
    url: noteUrl(noteId, xsecToken),
    source,
  };
}

/** 搜索/feed 响应（data.items[] 或 data.notes[]）批量提取。 */
export function noteCardsFromResponse(
  payload: Any,
  source: CollectSource,
): { items: NoteCard[]; hasMore: boolean; cursor: string } {
  const data = payload?.data ?? payload;
  const rawItems: Any[] = data?.items ?? data?.notes ?? [];
  const items = rawItems
    // 搜索接口混有 user/aggregate 等非笔记条目
    .filter((it) => { const model = it?.model_type ?? it?.modelType; return !model || model === "note"; })
    .map((it) => noteCardFromItem(it, source))
    .filter((x): x is NoteCard => x !== null);
  return {
    items,
    hasMore: Boolean(data?.has_more ?? data?.hasMore),
    cursor: str(data?.cursor ?? ""),
  };
}

/** __INITIAL_STATE__ 里指定路径的笔记列表（feed.feeds / user.notes / search.feeds）。 */
export function noteCardsFromInitialState(state: Any, path: string, source: CollectSource): NoteCard[] {
  let cur: any = state;
  for (const key of path.split(".")) {
    cur = unwrap(cur?.[key]);
    if (cur == null) return [];
  }
  const list = Array.isArray(cur) ? cur : unwrap(cur?.[0]);
  if (!Array.isArray(list)) return [];
  return list
    .map((it: Any) => noteCardFromItem(unwrap(it), source))
    .filter((x): x is NoteCard => x !== null);
}

/** feed 详情接口 data.items[0].note_card -> NoteDetail。 */
export function noteDetailFromFeedResponse(payload: Any, fallback?: Partial<NoteCard>): NoteDetail | null {
  const items = payload?.data?.items;
  const card = Array.isArray(items) ? items[0]?.note_card : payload?.data?.note_card;
  if (!card) return null;
  const noteId = str(card.note_id ?? items?.[0]?.id ?? fallback?.noteId ?? "");
  if (!noteId) return null;
  const user = card.user ?? {};
  const ii = card.interact_info ?? {};
  const images: NoteImage[] = (Array.isArray(card.image_list) ? card.image_list : [])
    .map((img: Any) => ({
      url: imageUrl(img),
      width: img?.width,
      height: img?.height,
    }))
    .filter((i: NoteImage) => i.url);
  const videoUrl =
    card.video?.media?.stream?.h264?.[0]?.master_url ??
    card.video?.media?.stream?.h265?.[0]?.master_url ??
    card.video?.media?.stream?.av1?.[0]?.master_url ??
    card.video?.url ??
    deepMediaUrl(card.video) ??
    (card.video?.consumer?.originVideoKey || card.video?.consumer?.origin_video_key
      ? `https://sns-video-qc.xhscdn.com/${str(card.video.consumer.originVideoKey ?? card.video.consumer.origin_video_key)}`
      : undefined);
  // 部分响应把流地址放在非常规路径，兜底深搜 video 子树；
  // 只有 key（非 URL）时按 xhscdn 域名构造播放地址
  function deepMediaUrl(v: Any, depth = 0): string | undefined {
    if (!v || typeof v !== "object" || depth > 6) return undefined;
    for (const [k, val] of Object.entries(v)) {
      if (
        (k === "master_url" || k === "origin_video_key" || k === "originVideoKey" || k === "url") &&
        typeof val === "string" &&
        /^https?:\/\//.test(val)
      )
        return val;
    }
    for (const val of Object.values(v)) {
      if (val && typeof val === "object") {
        const found = deepMediaUrl(val, depth + 1);
        if (found) return found;
      }
    }
    return undefined;
  }
  const tagList: Any[] = card.tag_list ?? card.tagList ?? [];
  const xsecToken = str(items?.[0]?.xsec_token ?? fallback?.xsecToken ?? "");
  return {
    noteId,
    xsecToken,
    type: card.type === "video" || videoUrl ? "video" : "image",
    title: str(card.title ?? card.display_title),
    desc: str(card.desc),
    content: str(card.desc),
    tags: tagList.map((t) => str(t?.name)).filter(Boolean),
    images,
    videoUrl,
    author: {
      userId: str(user.user_id ?? ""),
      nickname: str(user.nickname ?? user.nick_name ?? ""),
      avatar: normalizeXhsMediaUrl(str(user.avatar ?? user.image ?? "")),
    },
    cover: imageUrl(card.cover) || images[0]?.url || "",
    likes: num(ii.liked_count),
    collects: num(ii.collected_count),
    comments: num(ii.comment_count),
    shares: num(ii.share_count),
    url: noteUrl(noteId, xsecToken),
    publishedAt: str(card.time ?? card.last_update_time ?? ""),
    ipLocation: str(card.ip_location ?? ""),
  };
}

/** 评论接口 data.comments[] -> NoteComment[]。 */
export function commentsFromResponse(payload: Any): NoteComment[] {
  const list: Any[] = payload?.data?.comments ?? [];
  return list.map((c) => ({
    commentId: str(c.id ?? c.comment_id),
    userName: str(c.user_info?.nickname ?? c.user?.nickname ?? ""),
    userId: str(c.user_info?.user_id ?? c.user?.user_id ?? "") || undefined,
    avatar: normalizeXhsMediaUrl(str(c.user_info?.image ?? c.user_info?.avatar ?? c.user?.image ?? c.user?.avatar ?? "")),
    content: str(c.content),
    likes: num(c.like_count ?? c.likes),
    subComments: Array.isArray(c.sub_comments)
      ? c.sub_comments.map((s: Any) => ({
          commentId: str(s.id ?? s.comment_id),
          userName: str(s.user_info?.nickname ?? ""),
          userId: str(s.user_info?.user_id ?? s.user?.user_id ?? "") || undefined,
          avatar: normalizeXhsMediaUrl(str(s.user_info?.image ?? s.user_info?.avatar ?? s.user?.image ?? s.user?.avatar ?? "")),
          content: str(s.content),
          likes: num(s.like_count),
        }))
      : undefined,
  }));
}

/** 嗅探 URL 分类：返回该 URL 对应的采集场景，null = 不关心。 */
export function classifyXhsApiUrl(url: string): { source: CollectSource; kind: "list" | "comments" } | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const p = u.pathname;
  if (p === "/api/sns/web/v1/homefeed") return { source: "homefeed", kind: "list" };
  if (p === "/api/sns/web/v1/search/notes" || p === "/api/sns/web/v2/search/notes")
    return { source: "search", kind: "list" };
  if (p === "/api/sns/web/v1/user_posted") return { source: "user_posted", kind: "list" };
  if (p === "/api/sns/web/v2/note/collect/page") return { source: "collect_page", kind: "list" };
  if (p === "/api/sns/web/v1/note/like/page") return { source: "like_page", kind: "list" };
  if (p === "/api/sns/web/v2/comment/page" || p === "/api/sns/web/v2/comment/sub/page")
    return { source: "detail", kind: "comments" };
  return null;
}
