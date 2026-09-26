/**
 * 创作中心 galaxy API（creator.xiaohongshu.com/api/galaxy/*）响应解析。
 * 纯函数 + 容错键名——服务端从不自己签名请求，这些响应一律来自插件嗅探。
 */

export interface GalaxyPostedNote {
  noteId: string;
  title: string;
  xsecToken: string;
  url: string;
  /** unix ms（秒级时间戳自动 ×1000）；解析不到为 undefined。 */
  publishTime?: number;
  status?: string;
}

export interface GalaxyMetricsRow {
  noteId: string;
  views?: number;
  likes?: number;
  collects?: number;
  comments?: number;
  shares?: number;
  exposure?: number;
}

export interface GalaxyPersonalInfo {
  followers?: number;
  likesTotal?: number;
  notesCount?: number;
}

type Any = Record<string, any>;

const pick = (o: Any | undefined, ...keys: string[]): any => {
  if (!o || typeof o !== "object") return undefined;
  for (const k of keys) if (o[k] != null) return o[k];
  return undefined;
};

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" ? Number(v.replace(/[^\d.-]/g, "")) : Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** 秒级时间戳 → ms；非数字原样尝试 Date.parse。 */
const timeMs = (v: unknown): number | undefined => {
  const n = num(v);
  if (n !== undefined) return n < 1e12 ? n * 1000 : n;
  if (typeof v === "string") {
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : undefined;
  }
  return undefined;
};

const asArr = (v: unknown): Any[] => (Array.isArray(v) ? v : []);

/** 在响应对象里找第一个非空数组字段（data.list / data.notes / data.items …）。 */
function findList(json: Any): Any[] {
  const data = (json?.data ?? json) as Any;
  for (const k of [
    "notes",
    "list",
    "items",
    "rows",
    "posted_notes",
    "note_list",
    "result",
  ]) {
    const v = data?.[k];
    if (Array.isArray(v) && v.length) return v as Any[];
    // 再深一层：data.notes.items 这类
    if (v && typeof v === "object") {
      for (const kk of ["items", "list", "notes", "rows"]) {
        if (Array.isArray(v[kk]) && v[kk].length) return v[kk] as Any[];
      }
    }
  }
  return [];
}

/** galaxy 响应是否判定为未登录/鉴权失败。 */
export function isAuthError(json: Any, httpStatus?: number): boolean {
  if (httpStatus === 401 || httpStatus === 403) return true;
  const code = num(json?.code);
  if (code !== undefined && [-100, -101, -102, 460, 461].includes(code)) return true;
  if (json?.success === false) {
    const msg = String(json?.msg ?? json?.message ?? "");
    if (/登录|登陆|login/i.test(msg)) return true;
  }
  return false;
}

/** 已发笔记列表 → 规范化项。 */
export function postedNotesFromResponse(json: Any): GalaxyPostedNote[] {
  const out: GalaxyPostedNote[] = [];
  for (const it of findList(json)) {
    const noteId = String(pick(it, "id", "note_id", "noteId", "noteid") ?? "");
    const title = String(pick(it, "title", "display_title", "displayTitle", "note_title") ?? "");
    if (!noteId && !title) continue;
    const xsecToken = String(pick(it, "xsec_token", "xsecToken", "xsecTokenV2") ?? "");
    const status = pick(it, "status", "audit_status", "post_status");
    out.push({
      noteId,
      title,
      xsecToken,
      url: noteId
        ? `https://www.xiaohongshu.com/explore/${noteId}${xsecToken ? `?xsec_token=${xsecToken}` : ""}`
        : "",
      publishTime: timeMs(
        pick(it, "publish_time", "publishTime", "time", "create_time", "created_at", "createTime"),
      ),
      status: status == null ? undefined : String(status),
    });
  }
  return out;
}

/** 笔记分析列表 → 规范化指标行。 */
export function metricsRowsFromResponse(json: Any): GalaxyMetricsRow[] {
  const out: GalaxyMetricsRow[] = [];
  for (const it of findList(json)) {
    // 嵌套变体：{note: {id}}, {note_id}
    const inner = (pick(it, "note", "note_info", "noteInfo") ?? {}) as Any;
    const noteId = String(
      pick(it, "note_id", "noteId", "id") ?? pick(inner, "id", "note_id", "noteId") ?? "",
    );
    if (!noteId) continue;
    out.push({
      noteId,
      views: num(pick(it, "view_count", "views", "page_view", "pv", "play_count", "read_count")),
      likes: num(pick(it, "like_count", "likes", "liked_count")),
      collects: num(pick(it, "collected_count", "collect_count", "collects", "fav_count")),
      comments: num(pick(it, "comment_count", "comments")),
      shares: num(pick(it, "share_count", "shares")),
      exposure: num(pick(it, "exposure", "exposure_count", "imp_count", "impression_count", "impressions")),
    });
  }
  return out;
}

/** personal_info → 账号概览。 */
export function personalInfoFromResponse(json: Any): GalaxyPersonalInfo {
  const data = (json?.data ?? {}) as Any;
  const user = (pick(data, "user", "user_info", "userInfo") ?? data) as Any;
  const stats = (pick(user, "stats", "statistics", "stat") ?? {}) as Any;
  const pickNum = (...keys: string[]) => num(pick(user, ...keys)) ?? num(pick(stats, ...keys)) ?? num(pick(data, ...keys));
  return {
    followers: pickNum("fans_count", "follower_count", "followers", "fans"),
    likesTotal: pickNum("liked_count", "like_count", "likes_total", "liked_total"),
    notesCount: pickNum("notes_count", "note_count", "notes_total", "published_count", "works_count"),
  };
}
