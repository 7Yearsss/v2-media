/**
 * 工作台 REST client —— fetch 封装：Bearer token、query 序列化、统一错误。
 * 契约见 docs/api-contract.md；只读 @v2media/shared 的类型。
 */
import { normalizeXhsMediaUrl } from "@v2media/shared/xhs-parse";
import { assertCurrentSession, captureSession, clearSession, UNAUTHORIZED_EVENT, type SessionContext } from "./session";
export { captureSession, clearSession, getStoredUser, getToken, isCurrentSession, setSession, SessionChangedError, UNAUTHORIZED_EVENT } from "./session";
export type { SessionContext, SessionUser } from "./session";
import type {
  AiRewriteRequest,
  AiRewriteResponse,
  AiTagsRequest,
  AiTitlesRequest,
  AiTopicScoreRequest,
  AiTopicsRequest,
  AiTopicsResponse,
  AuthRequest,
  AuthResponse,
  CollectedNote,
  NotesSummary,
  Collection,
  CollectionAnalysis,
  CollectionAnalyzeRequest,
  AccountPersonaUpdateRequest,
  Draft,
  DraftCreateRequest,
  DraftUpdateRequest,
  CoverCreateRequest,
  DraftJobResponse,
  MediaAsset,
  MediaUploadResponse,
  HostedAccount,
  InsightsQuery, InsightsOverview, InsightsNotesPage, InsightNoteDetail, PostmortemReport, PostmortemCreateRequest,
  CollectionTask, CollectionTaskRules, CollectionTaskDetail, CollectionControlRequest,
  NoteComment,
  PublishJob,
  PublishJobCreateRequest,
  PublishJobRetryRequest,
  Topic,
  TopicCreateRequest,
  TopicToDraftResponse,
  TopicToDraftRequest,
  TopicUpdateRequest,
} from "@v2media/shared";

/** 插件 SET_AUTH 使用的服务端地址（扩展上下文里没有 vite 代理）。 */
export const API_BASE =
  (import.meta.env.VITE_API_BASE_URL as string | undefined) ??
  "http://127.0.0.1:3000";

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
    response?: "blob";
  } = {},
  session: SessionContext = captureSession(),
): Promise<T> {
  assertCurrentSession(session);
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
  if (init.body !== undefined && !(init.body instanceof FormData)) headers["Content-Type"] = "application/json";
  const token = session.token;
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body === undefined ? undefined : init.body instanceof FormData ? init.body : JSON.stringify(init.body),
      signal: session.signal,
    });
  } catch {
    assertCurrentSession(session);
    throw new ApiError("网络异常，无法连接服务端", 0);
  }

  assertCurrentSession(session);

  if (res.status === 401) {
    clearSession(session);
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
    assertCurrentSession(session);
    throw new ApiError(message, res.status);
  }

  if (res.status === 204) return undefined as T;
  const result = init.response === "blob" ? await res.blob() : await res.json();
  assertCurrentSession(session);
  return result as T;
}

// ---------- 归一化响应类型 ----------

/** 内容库范围筛选（0/缺省 = 不限）。 */
export interface NoteRangeFilter {
  type?: "image" | "video";
  minLikes?: number;
  withinDays?: number;
  /** 只看某个作者（站点作者 id）。 */
  authorId?: string;
  /** 仅界面展示用（筛选条上的「作者：xxx」），不会发给服务端。 */
  authorName?: string;
}

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
  aiRuns: (query: { kind?: import("@v2media/shared").AiRunKind; status?: import("@v2media/shared").AiRunStatus } = {}, session?: SessionContext) =>
    request<{ items: import("@v2media/shared").AiRun[] }>("/api/ai/runs", { query: { ...query } }, session),
  aiRun: (id: number, session?: SessionContext) => request<import("@v2media/shared").AiRun>(`/api/ai/runs/${id}`, {}, session),
  retryAiRun: (id: number, body: import("@v2media/shared").AiRunRetryRequest, session?: SessionContext) =>
    request<import("@v2media/shared").AiRun>(`/api/ai/runs/${id}/retry`, { method: "POST", body }, session),
  cancelAiRun: (id: number, session?: SessionContext) =>
    request<import("@v2media/shared").AiRun>(`/api/ai/runs/${id}/cancel`, { method: "POST" }, session),
  runtime: () => request<import("@v2media/shared").ServerRuntimeStatus>("/api/runtime"),
  collectionTasks: () => request<{ items: CollectionTask[] }>("/api/collection-tasks"),
  collectionTask: (id: number, offset = 0) => request<CollectionTaskDetail>(`/api/collection-tasks/${id}`, { query: { offset } }),
  createCollectionTask: (body: CollectionTaskRules) => request<CollectionTask>("/api/collection-tasks", { method: "POST", body }),
  controlCollectionTask: (id: number, body: CollectionControlRequest) => request<CollectionTask>(`/api/collection-tasks/${id}/control`, { method: "POST", body }),
  insightsOverview: (query: InsightsQuery) => request<InsightsOverview>("/api/insights/overview", { query: { ...query } }),
  insightsNotes: (query: InsightsQuery) => request<InsightsNotesPage>("/api/insights/notes", { query: { ...query } }),
  insightNote: (id: number) => request<InsightNoteDetail>(`/api/insights/notes/${id}`),
  postmortem: (publishJobId: number, refresh = false) => request<PostmortemReport>("/api/ai/postmortem", { method: "POST", body: { publishJobId, refresh } satisfies PostmortemCreateRequest }),
  register: (body: AuthRequest, session?: SessionContext) =>
    request<AuthResponse>("/api/auth/register", { method: "POST", body }, session),
  login: (body: AuthRequest, session?: SessionContext) =>
    request<AuthResponse>("/api/auth/login", { method: "POST", body }, session),

  accounts: () => request<HostedAccount[]>("/api/accounts"),
  accountsIncludingArchived: () => request<HostedAccount[]>("/api/accounts", { query: { includeArchived: 1 } }),
  restoreAccount: (id: number) => request<HostedAccount>(`/api/accounts/${id}/restore`, { method: "POST" }),
  updateAccountPersona: (id: number, body: AccountPersonaUpdateRequest) =>
    request<HostedAccount>(`/api/accounts/${id}`, { method: "PATCH", body }),
  deleteAccount: (id: number) =>
    request<void>(`/api/accounts/${id}`, { method: "DELETE" }),

  notes: (params: {
    keyword?: string;
    tag?: string;
    source?: string;
    /** 数字=该库；"none"=未分组；缺省=全部 */
    collectionId?: string;
    cursor?: string | null;
    sort?: NoteSortField;
    direction?: NoteSortDirection;
  } & NoteRangeFilter) =>
    request<NotesPage>("/api/notes", {
      query: {
        keyword: params.keyword,
        tag: params.tag,
        source: params.source,
        collectionId: params.collectionId || undefined,
        cursor: params.cursor ?? undefined,
        sort: params.sort,
        direction: params.direction,
        type: params.type,
        minLikes: params.minLikes,
        withinDays: params.withinDays,
        authorId: params.authorId,
      },
    }).then((res) =>
      // 防御：服务端若直接返回数组也兜住
      Array.isArray(res)
        ? { items: res, nextCursor: null }
        : { items: res.items ?? [], nextCursor: res.nextCursor ?? null },
    ),
  /** 当前筛选范围的摘要（与 notes 同一套筛选，不含分页/排序）。 */
  notesSummary: (params: { keyword?: string; source?: string; collectionId?: string; tag?: string } & NoteRangeFilter) =>
    request<NotesSummary>("/api/notes/summary", {
      query: { ...params, authorName: undefined, collectionId: params.collectionId || undefined },
    }),
  collections: () => request<{ items: Collection[] }>("/api/collections"),
  createCollection: (name: string) =>
    request<Collection>("/api/collections", { method: "POST", body: { name } }),
  renameCollection: (id: number, name: string) =>
    request<Collection>(`/api/collections/${id}`, { method: "PATCH", body: { name } }),
  deleteCollection: (id: number) =>
    request<void>(`/api/collections/${id}`, { method: "DELETE" }),
  analyzeCollection: (id: number, opts: CollectionAnalyzeRequest = {}, session?: SessionContext) =>
    request<CollectionAnalysis>(`/api/collections/${id}/analyze`, { method: "POST", body: opts }, session),
  collectionAnalyses: (id: number) =>
    request<{ items: Omit<CollectionAnalysis, "report" | "data">[] }>(`/api/collections/${id}/analyses`),
  collectionAnalysis: (id: number, aid: number) =>
    request<CollectionAnalysis>(`/api/collections/${id}/analyses/${aid}`),

  note: (id: number) => request<NoteDetail>(`/api/notes/${id}`),
  deleteNote: (id: number) =>
    request<void>(`/api/notes/${id}`, { method: "DELETE" }),
  /** GET /api/notes/export → CSV blob（带 BOM，Excel 直开）。 */
  exportNotes: async (f?: { collectionId?: string; keyword?: string; source?: string; tag?: string; ids?: number[] } & NoteRangeFilter): Promise<Blob> => {
    const p = new URLSearchParams();
    if (f?.collectionId) p.set("collectionId", f.collectionId);
    if (f?.keyword) p.set("keyword", f.keyword);
    if (f?.source) p.set("source", f.source);
    if (f?.tag) p.set("tag", f.tag);
    if (f?.type) p.set("type", f.type);
    if (f?.minLikes) p.set("minLikes", String(f.minLikes));
    if (f?.withinDays) p.set("withinDays", String(f.withinDays));
    if (f?.authorId) p.set("authorId", f.authorId);
    if (f?.ids?.length) p.set("ids", f.ids.join(","));
    const qs = p.size ? `?${p}` : "";
    return request<Blob>(`/api/notes/export${qs}`, { response: "blob" });
  },

  /** 批量移库（collectionId=null 移出）或删除，返回实际影响条数。 */
  batchNotes: (body: { action: "move"; ids: number[]; collectionId: number | null } | { action: "delete"; ids: number[] }) =>
    request<{ affected: number }>("/api/notes/batch", { method: "POST", body }),

  drafts: () => request<Draft[]>("/api/drafts"),
  draftsIncludingArchived: () => request<Draft[]>("/api/drafts", { query: { includeArchived: 1 } }),
  restoreDraft: (id: number) => request<Draft>(`/api/drafts/${id}/restore`, { method: "POST" }),
  uploadImage: (draftId: number, imagesVersion: number, file: File, uploadId: string, session?: SessionContext) => {
    const form = new FormData();
    form.set("draftId", String(draftId));
    form.set("imagesVersion", String(imagesVersion));
    form.set("uploadId", uploadId);
    form.set("file", file);
    return request<MediaUploadResponse>("/api/media/upload", { method: "POST", body: form }, session);
  },
  retryImage: (id: number) => request<MediaAsset>(`/api/media/assets/${id}/retry`, { method: "POST" }),
  draft: (id: number, session?: SessionContext) => request<Draft>(`/api/drafts/${id}`, {}, session),
  generateCover: (id: number, body: CoverCreateRequest, session?: SessionContext) =>
    request<DraftJobResponse>(`/api/drafts/${id}/cover`, { method: "POST", body }, session),
  retryGeneration: (id: number, session?: SessionContext) =>
    request<DraftJobResponse>(`/api/drafts/${id}/generate/retry`, { method: "POST" }, session),
  createDraft: (body: DraftCreateRequest = {}) =>
    request<Draft>("/api/drafts", { method: "POST", body }),
  updateDraft: (id: number, body: DraftUpdateRequest, session?: SessionContext) =>
    request<Draft>(`/api/drafts/${id}`, { method: "PATCH", body }, session),
  deleteDraft: (id: number, session?: SessionContext) =>
    request<void>(`/api/drafts/${id}`, { method: "DELETE" }, session),

  aiRewrite: (body: AiRewriteRequest, session?: SessionContext) =>
    request<AiRewriteResponse>("/api/ai/rewrite", { method: "POST", body }, session),
  aiTitles: (body: AiTitlesRequest, session?: SessionContext) =>
    request<{ titles: string[] }>("/api/ai/titles", { method: "POST", body }, session),
  aiTags: (body: AiTagsRequest, session?: SessionContext) =>
    request<{ tags: string[] }>("/api/ai/tags", { method: "POST", body }, session),

  topics: (status?: string) =>
    request<{ items: Topic[] }>("/api/topics", {
      query: { status: status || undefined },
    }),
  createTopic: (body: TopicCreateRequest, session?: SessionContext) =>
    request<Topic>("/api/topics", { method: "POST", body }, session),
  updateTopic: (id: number, body: TopicUpdateRequest) =>
    request<Topic>(`/api/topics/${id}`, { method: "PATCH", body }),
  deleteTopic: (id: number) =>
    request<void>(`/api/topics/${id}`, { method: "DELETE" }),
  topicToDraft: (id: number, opts?: TopicToDraftRequest, session?: SessionContext) =>
    request<TopicToDraftResponse>(`/api/topics/${id}/to-draft`, { method: "POST", body: opts }, session),
  aiTopics: (body: AiTopicsRequest, session?: SessionContext) =>
    request<AiTopicsResponse>("/api/ai/topics", { method: "POST", body }, session),
  aiTopicScore: (body: AiTopicScoreRequest, session?: SessionContext) =>
    request<import("@v2media/shared").AiRun>("/api/ai/topic-score", {
      method: "POST",
      body,
    }, session),

  jobs: () => request<PublishJob[]>("/api/publish/jobs"),
  createJob: (body: PublishJobCreateRequest) =>
    request<PublishJob>("/api/publish/jobs", { method: "POST", body }),
  cancelJob: (id: number) =>
    request<PublishJob>(`/api/publish/jobs/${id}/cancel`, { method: "POST" }),
  retryJob: (id: number, body: PublishJobRetryRequest, session?: SessionContext) =>
    request<PublishJob>(`/api/publish/jobs/${id}/retry`, { method: "POST", body }, session),

  overview: () => request<unknown>("/api/overview").then(normalizeOverview),
};

/** 封面/图片地址：xhscdn/xiaohongshu 需要 Referer，走服务端代理；其余直出。 */
export function mediaUrl(u?: string): string {
  if (!u) return "";
  try {
    const host = new URL(u).hostname;
    if (/(^|\.)xhscdn\.com$|(^|\.)xiaohongshu\.com$/.test(host))
      return `/api/media/proxy?url=${encodeURIComponent(normalizeXhsMediaUrl(u))}`;
  } catch {
    // 非法 URL 直出
  }
  return u;
}
import type { NoteSortField, NoteSortDirection } from "@v2media/shared";
