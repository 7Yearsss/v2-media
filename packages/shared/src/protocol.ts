/**
 * 工作台页面 <-> 插件 双向消息协议（window.postMessage，同源校验）。
 * 服务端 REST API 的载荷类型也在这里统一定义。
 */

import type { CollectBatch, Draft, HostedAccount, PublishJob, Topic, TopicStatus } from "./types";

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
