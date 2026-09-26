/**
 * 工作台 REST client —— fetch 封装：Bearer token、query 序列化、统一错误。
 * 契约见 docs/api-contract.md；只读 @v2media/shared 的类型。
 */
import type {
  AiRewriteRequest,
  AiRewriteResponse,
  AiTagsRequest,
  AiTitlesRequest,
  AuthRequest,
  AuthResponse,
  CollectedNote,
  Draft,
  DraftCreateRequest,
  DraftUpdateRequest,
  HostedAccount,
  NoteComment,
  PublishJob,
  PublishJobCreateRequest,
} from "@v2media/shared";

const TOKEN_KEY = "v2m.token";
const USER_KEY = "v2m.user";

/** 插件 SET_AUTH 使用的服务端地址（扩展上下文里没有 vite 代理）。 */
export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  "http://127.0.0.1:3000";

export interface SessionUser {
  id: number;
  email: string;
}

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function getStoredUser(): SessionUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    return raw ? (JSON.parse(raw) as SessionUser) : null;
  } catch {
    return null;
  }
}

export function setSession(token: string, user: SessionUser) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

/** 401 时广播，AuthProvider 监听后强制回登录页。 */
export const UNAUTHORIZED_EVENT = "v2m:unauthorized";

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

type QueryValue = string | number | undefined | null;

async function request<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    query?: Record<string, QueryValue>;
  } = {},
): Promise<T> {
  let url = path;
  if (init.query) {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(init.query)) {
      if (value === undefined || value === null || value === "") continue;
      params.set(key, String(value));
    }
    const qs = params.toString();
    if (qs) url += `?${qs}`;
  }

  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    throw new ApiError("网络异常，无法连接服务端", 0);
  }

  if (res.status === 401) {
    clearSession();
    window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    throw new ApiError("登录已过期，请重新登录", 401);
  }

  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = (await res.json()) as { error?: string };
      if (data?.error) message = data.error;
    } catch {
      // 非 JSON 错误体，用默认文案
    }
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ---------- 归一化响应类型 ----------

/** GET /api/notes 分页载荷（契约：{items,nextCursor}）。 */
export interface NotesPage {
  items: CollectedNote[];
  nextCursor: string | null;
}

/** GET /api/notes/:id —— 详情在 CollectedNote 之上可能附带评论。 */
export interface NoteDetail extends CollectedNote {
  /** 服务端字段名（schema commentsData）。 */
  commentsData?: unknown;
}

export function noteComments(detail: NoteDetail | undefined): NoteComment[] {
  if (!detail) return [];
  const raw = detail.commentsData;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is NoteComment =>
      typeof c === "object" && c !== null && "content" in c,
  );
}

/** GET /api/overview —— 契约只写了「仪表盘计数」，这里做多键名防御归一。 */
export interface OverviewStats {
  notes: number;
  drafts: number;
  accounts: number;
  /** 0-100；服务端未提供时为 null。 */
  publishSuccessRate: number | null;
  /** 近 7 天采集趋势（合计）。 */
  trend: { label: string; count: number }[];
  /** 按采集来源拆分的趋势（若服务端提供）：source → 各期值。 */
  trendBySource: { source: string; values: number[] }[];
}

function num(...vals: unknown[]): number {
  for (const v of vals) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return 0;
}

export function normalizeOverview(raw: unknown): OverviewStats {
  const r = (raw ?? {}) as Record<string, unknown>;
  let rate: number | null = null;
  const rateRaw = r.publishSuccessRate ?? r.successRate ?? r.publishRate;
  if (typeof rateRaw === "number" && Number.isFinite(rateRaw)) {
    rate = rateRaw; // 服务端契约：0-100 百分比（不再对 ≤1 做比例猜测）
  }

  const trendRaw = r.trend ?? r.collectTrend ?? r.daily;
  const trend: { label: string; count: number }[] = [];
  const bySource = new Map<string, number[]>();
  if (Array.isArray(trendRaw)) {
    trendRaw.forEach((item, idx) => {
      if (typeof item === "number") {
        trend.push({ label: "", count: item });
        return;
      }
      if (typeof item !== "object" || item === null) return;
      const o = item as Record<string, unknown>;
      const label =
        typeof o.label === "string"
          ? o.label
          : typeof o.date === "string"
            ? o.date
            : "";
      // {label, sources:{search:3, homefeed:2,…}} 或 {label, source:'search', count}
      if (typeof o.sources === "object" && o.sources !== null) {
        let total = 0;
        for (const [src, v] of Object.entries(o.sources)) {
          const c = num(v);
          total += c;
          const arr = bySource.get(src) ?? [];
          arr[idx] = c;
          bySource.set(src, arr);
        }
        trend.push({ label, count: total });
      } else if (typeof o.source === "string") {
        const c = num(o.count, o.value, o.total);
        const arr = bySource.get(o.source) ?? [];
        arr[idx] = c;
        bySource.set(o.source, arr);
        trend.push({ label, count: c });
      } else {
        trend.push({ label, count: num(o.count, o.value, o.total) });
      }
    });
  }

  const trendBySource = [...bySource.entries()].map(([source, values]) => ({
    source,
    // 对齐到 trend 长度，缺位补 null 由图表断档处理
    values: trend.map((_, i) => values[i] ?? 0),
  }));

  return {
    notes: num(r.notes, r.noteCount, r.totalNotes, r.collectedNotes),
    drafts: num(r.drafts, r.draftCount, r.totalDrafts),
    accounts: num(r.accounts, r.accountCount, r.totalAccounts),
    publishSuccessRate: rate,
    trend,
    trendBySource,
  };
}

// ---------- 端点 ----------

export const api = {
  register: (body: AuthRequest) =>
    request<AuthResponse>("/api/auth/register", { method: "POST", body }),
  login: (body: AuthRequest) =>
    request<AuthResponse>("/api/auth/login", { method: "POST", body }),

  accounts: () => request<HostedAccount[]>("/api/accounts"),
  deleteAccount: (id: number) =>
    request<void>(`/api/accounts/${id}`, { method: "DELETE" }),

  notes: (params: {
    keyword?: string;
    tag?: string;
    source?: string;
    cursor?: string | null;
  }) =>
    request<NotesPage>("/api/notes", {
      query: {
        keyword: params.keyword,
        tag: params.tag,
        source: params.source,
        cursor: params.cursor ?? undefined,
      },
    }).then((res) =>
      // 防御：服务端若直接返回数组也兜住
      Array.isArray(res)
        ? { items: res, nextCursor: null }
        : { items: res.items ?? [], nextCursor: res.nextCursor ?? null },
    ),
  note: (id: number) => request<NoteDetail>(`/api/notes/${id}`),
  deleteNote: (id: number) =>
    request<void>(`/api/notes/${id}`, { method: "DELETE" }),

  drafts: () => request<Draft[]>("/api/drafts"),
  draft: (id: number) => request<Draft>(`/api/drafts/${id}`),
  createDraft: (body: DraftCreateRequest = {}) =>
    request<Draft>("/api/drafts", { method: "POST", body }),
  updateDraft: (id: number, body: DraftUpdateRequest) =>
    request<Draft>(`/api/drafts/${id}`, { method: "PATCH", body }),
  deleteDraft: (id: number) =>
    request<void>(`/api/drafts/${id}`, { method: "DELETE" }),

  aiRewrite: (body: AiRewriteRequest) =>
    request<AiRewriteResponse>("/api/ai/rewrite", { method: "POST", body }),
  aiTitles: (body: AiTitlesRequest) =>
    request<{ titles: string[] }>("/api/ai/titles", { method: "POST", body }),
  aiTags: (body: AiTagsRequest) =>
    request<{ tags: string[] }>("/api/ai/tags", { method: "POST", body }),

  jobs: () => request<PublishJob[]>("/api/publish/jobs"),
  createJob: (body: PublishJobCreateRequest) =>
    request<PublishJob>("/api/publish/jobs", { method: "POST", body }),
  cancelJob: (id: number) =>
    request<PublishJob>(`/api/publish/jobs/${id}/cancel`, { method: "POST" }),

  overview: () => request<unknown>("/api/overview").then(normalizeOverview),
};

/** 封面/图片地址：xhscdn/xiaohongshu 需要 Referer，走服务端代理；其余直出。 */
export function mediaUrl(u?: string): string {
  if (!u) return "";
  try {
    const host = new URL(u).hostname;
    if (/(^|\.)xhscdn\.com$|(^|\.)xiaohongshu\.com$/.test(host))
      return `/api/media/proxy?url=${encodeURIComponent(u)}`;
  } catch {
    // 非法 URL 直出
  }
  return u;
}
