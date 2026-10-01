/**
 * 工作台页面 <-> 插件 双向消息协议（window.postMessage，同源校验）。
 * 服务端 REST API 的载荷类型也在这里统一定义。
 */

import type {
  CollectBatch,
  Draft,
  HostedAccount,
  PublishJob,
  PublishOutcome,
  Topic,
  TopicStatus,
} from "./types";

// ---------- window.postMessage 桥（site-bridge.ts 实现） ----------

export const WEB_SOURCE = "v2m-web";
export const EXT_SOURCE = "v2m-ext";

export interface BridgeRequest<T = unknown> {
  source: typeof WEB_SOURCE;
  type: BridgeRequestType;
  requestId: string;
  payload?: T;
}

export interface BridgeResponse<T = unknown> {
  source: typeof EXT_SOURCE;
  requestId: string;
  ok: boolean;
  result?: T;
  error?: string;
}

export type BridgeRequestType =
  /** 工作台探测插件是否在线。 */
  | "PING"
  /** 工作台把 API base + token 写入插件 storage（授权插件按钮）。 */
  | "SET_AUTH"
  /** 要求插件上报当前浏览器里登录的小红书账号。 */
  | "SYNC_ACCOUNTS"
  /** 让插件打开某个 URL 并采集详情页。 */
  | "COLLECT_URL"
  /** 立即执行某个发布任务（工作台触发；也可由插件自己轮询）。 */
  | "RUN_PUBLISH_JOB";

export interface SetAuthPayload {
  apiBase: string;
  token: string;
}

export interface CollectUrlPayload {
  url: string;
}

export interface RunPublishJobPayload {
  jobId: number;
}

// ---------- REST API 载荷 ----------

export interface ApiError {
  error: string;
}

/** POST /api/auth/register | /api/auth/login */
export interface AuthRequest {
  email: string;
  password: string;
}
export interface AuthResponse {
  token: string;
  user: { id: number; email: string };
}

/** POST /api/ext/accounts/heartbeat —— 插件周期性上报托管账号。 */
export interface AccountHeartbeat {
  accounts: Array<{
    xhsUserId: string;
    nickname: string;
    avatar: string;
    subType: "pc" | "creator";
    status: "online" | "expired";
    statusMessage?: string;
  }>;
}

/** POST /api/ext/collect —— 插件上报嗅探/采集到的笔记。 */
export type CollectRequest = CollectBatch;
export interface CollectResponse {
  saved: number;
  ids: number[];
}

/** POST /api/drafts —— 从收藏或空白创建草稿。 */
export interface DraftCreateRequest {
  collectedNoteId?: number;
  title?: string;
  content?: string;
  tags?: string[];
  images?: { url: string }[];
}
export interface DraftUpdateRequest {
  title?: string;
  content?: string;
  tags?: string[];
  images?: { url: string }[];
  status?: "draft" | "ready";
}

/** POST /api/ai/* —— 统一走 OpenAI 兼容网网。 */
export interface AiRewriteRequest {
  draftId?: number;
  title?: string;
  content?: string;
  instruction?: string;
}
export interface AiRewriteResponse {
  title: string;
  content: string;
}
export interface AiTitlesRequest {
  title: string;
  content?: string;
  count?: number;
}
export interface AiTagsRequest {
  title: string;
  content?: string;
  count?: number;
}

/** POST /api/publish/jobs */
export interface PublishJobCreateRequest {
  draftId: number;
  accountId: number;
  scheduledAt?: number;
  visibility?: "public" | "private" | "friends";
}

/** GET /api/ext/publish/pending —— 插件认领待执行任务（带账号过滤）。xhsUserId 供插件比对当前浏览器登录的托管账号。 */
export interface PendingPublishJobsResponse {
  jobs: Array<PublishJob & { xhsUserId: string; draft: { title: string; content: string; tags: string[]; images: { url: string }[] } }>;
}

/** POST /api/ext/publish/:id/result */
export interface PublishResultRequest {
  status: "done" | "failed";
  resultUrl?: string;
  error?: string;
}

// ---------- 选题池（策划层） ----------

/** POST /api/topics */
export interface TopicCreateRequest {
  title: string;
  angle?: string;
  collectionId?: number;
  sourceNoteId?: number;
  accountId?: number;
  /** unix ms；给上即 status=planned。 */
  plannedAt?: number;
}
export interface TopicUpdateRequest {
  title?: string;
  angle?: string;
  status?: TopicStatus;
  accountId?: number | null;
  plannedAt?: number | null;
}

/** POST /api/topics/:id/to-draft → { draft, topic } */
export interface TopicToDraftResponse {
  draft: Draft;
  topic: Topic;
  /** AI 成稿时的封面大字建议。 */
  coverText?: string;
  /** AI 成稿自查后仍命中的违禁词。 */
  warnings?: Array<{ word: string; kind: string; count: number }>;
}

/** POST /api/ai/topics —— 对采集库爆款笔记生成选题建议并直接入池（status=idea）。 */
export interface AiTopicsRequest {
  collectionId: number;
  count?: number;
  accountId?: number;
}
export interface AiTopicsResponse {
  items: Topic[];
}

/** POST /api/ai/topic-score —— 单条选题七维深评，回写 score/scoreDetail。 */
export interface AiTopicScoreRequest {
  topicId: number;
}

// ---------- 归因任务管道（切片②：读回对账 + 时序指标） ----------

/** 插件侧归因任务类型。调度在服务端 jobs 表，插件只做执行与回传。 */
export type ExtTaskType = "readback" | "metrics" | "account_snapshot";

/** 任务 payload（每种 type 的内部形状，服务端生成/消费）。 */
export interface ReadbackTaskPayload {
  publishJobId: number;
  /** 草稿标题（插件按前缀匹配已发列表）。 */
  title: string;
  /** 任务所属托管账号的 xhsUserId——浏览器登录号不一致时任务直接失败。 */
  xhsUserId?: string;
  /** 发布完成时间（unix ms）——匹配窗口下限。 */
  publishedAt: number;
}
export interface MetricsTaskPayload {
  publishJobId: number;
  noteId: string;
  xhsUserId?: string;
  /** www 详情页地址（readback 时落 resultUrl），metrics 任务打开它嗅探 feed 响应。 */
  noteUrl?: string;
}
export interface AccountSnapshotTaskPayload {
  accountId: number;
  xhsUserId?: string;
}
export type ExtTaskPayload =
  | ReadbackTaskPayload
  | MetricsTaskPayload
  | AccountSnapshotTaskPayload
  | Record<string, unknown>;

export interface ExtTask {
  id: number;
  type: ExtTaskType | string;
  payload: ExtTaskPayload;
}

/** GET /api/ext/tasks/pending?limit= —— dueAt<=now 的待执行任务。 */
export interface PendingTasksResponse {
  tasks: ExtTask[];
}

/** POST /api/ext/tasks/:id/claim */
export interface TaskClaimRequest {
  claimedBy: string;
}

/**
 * POST /api/ext/tasks/:id/result —— data 按 type 分形状：
 *  readback: PostedNotesData（已发列表原样回传，匹配在服务端做）
 *  metrics: MetricsData（该账号已发笔记的指标行）
 *  account_snapshot: AccountSnapshotData
 */
export interface TaskResultRequest {
  status: "done" | "failed";
  outcome?: PublishOutcome; // readback 专用：插件侧判定的粗结果（login 页也算 login_required）
  error?: string;
  data?: unknown;
}

/** posted 列表嗅探到的一条已发笔记（服务端做标题+时间窗匹配）。 */
export interface PostedNoteItem {
  noteId?: string;
  title?: string;
  xsecToken?: string;
  url?: string;
  /** unix ms 或 ISO——服务端宽松解析。 */
  publishTime?: string | number;
  status?: string; // 已发布/审核中/违规…，原样透传
}
export interface PostedNotesData {
  items: PostedNoteItem[];
}

/** 数据分析页一行指标（noteId → 各指标）。 */
export interface MetricsRow {
  noteId?: string;
  views?: number;
  likes?: number;
  collects?: number;
  comments?: number;
  shares?: number;
  exposure?: number;
}
export interface MetricsData {
  noteId?: string;      // 单篇模式（note_detail 页）
  rows?: MetricsRow[];  // 列表模式（analyze/list 页）
  extra?: Record<string, unknown>;
}

export interface AccountSnapshotData {
  followers?: number;
  likesTotal?: number;
  notesCount?: number;
  extra?: Record<string, unknown>;
}
