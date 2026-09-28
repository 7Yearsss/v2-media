/**
 * 插件内部消息协议：
 *  - MAIN world (xhs.ts) <-> isolated world (content.ts)：window CustomEvent
 *  - isolated / creator-publish / popup -> background：chrome.runtime.sendMessage
 * 契约类型一律复用 @v2media/shared，不在本文件重复定义业务形状。
 */

import type {
  CollectBatch,
  NoteCard,
  NoteComment,
  NoteDetail,
  PendingPublishJobsResponse,
} from "@v2media/shared";

// ---------- MAIN <-> isolated CustomEvent ----------

/** MAIN 嗅探/解析出的笔记批（detail 形状即 CollectBatch）。 */
export const EVT_NOTES = "v2m:notes";
/** MAIN 嗅探到的评论（CollectBatch 契约暂无评论字段，先缓存）。 */
export const EVT_COMMENTS = "v2m:comments";
/** isolated -> MAIN 请求。 */
export const EVT_REQ = "v2m:req";
/** MAIN -> isolated 响应。 */
export const EVT_RES = "v2m:res";
/** MAIN（creator.ts）-> isolated：创作中心 /api/galaxy/* 响应透传。 */
export const EVT_GALAXY = "v2m:galaxy";

/** creator 域 galaxy 响应（原始透传，解析交给 shared/galaxy-parse）。 */
export interface GalaxyEventDetail {
  url: string;
  path: string;
  httpStatus: number;
  json: Record<string, unknown>;
}

export interface CommentsEventDetail {
  noteId?: string;
  comments: NoteComment[];
}

export type MainAction =
  | "getNote"
  | "listCached"
  | "loginState"
  | "reparseInitialState"
  | "fetchDetail"; // 后台拉详情页 HTML 解 __INITIAL_STATE__（不用打开页面）

export interface MainRequest {
  requestId: string;
  action: MainAction;
  noteId?: string;
  url?: string;
}

export interface MainResponse {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface LoginState {
  loggedIn: boolean;
  userId: string;
  nickname: string;
  avatar: string;
}

export interface CachedNote {
  card?: NoteCard;
  detail?: NoteDetail;
  comments?: NoteComment[];
}

/** isolated world 调 MAIN world（window.CustomEvent 往返）。 */
export function mainRequest<T = unknown>(
  action: MainAction,
  extra: { noteId?: string; url?: string } = {},
  timeoutMs = 8000,
): Promise<T> {
  const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      document.removeEventListener(EVT_RES, onRes);
      reject(new Error("页面嗅探脚本无响应"));
    }, timeoutMs);
    function onRes(ev: Event) {
      const d = (ev as CustomEvent<MainResponse>).detail;
      if (!d || d.requestId !== requestId) return;
      document.removeEventListener(EVT_RES, onRes);
      clearTimeout(timer);
      if (d.ok) resolve(d.result as T);
      else reject(new Error(d.error ?? "页面数据读取失败"));
    }
    document.addEventListener(EVT_RES, onRes);
    document.dispatchEvent(
      new CustomEvent<MainRequest>(EVT_REQ, { detail: { requestId, action, ...extra } }),
    );
  });
}

// ---------- content/creator/popup -> background ----------

export type PublishJobPayload = PendingPublishJobsResponse["jobs"][number];

export type BgMessage =
  | { type: "EXT_COLLECT"; batch: CollectBatch }
  | { type: "GET_STATUS" }
  | {
      type: "COLLECT_URL_DONE";
      ok: boolean;
      noteId?: string;
      error?: string;
      detailCaptured?: boolean;
      commentsCaptured?: boolean;
      imageCount?: number;
    }
  | { type: "COLLECT_URL_CHALLENGE"; noteId?: string }
  | { type: "COLLECT_URL_CHALLENGE_DONE"; noteId?: string }
  // 深度采集：后台开隐藏标签页进详情，嗅探评论接口后自动关闭
  | { type: "DEEP_COLLECT"; url: string }
  | { type: "DEEP_COLLECT_CANCEL"; noteId: string } // 弹窗采集成功后取消队列里同笔记的兜底任务
  | { type: "GET_LOGIN_STATE" } // bg -> xhs content script
  | { type: "JOB_READY"; jobId: number } // creator-publish -> bg（拉取任务数据）
  | {
      type: "JOB_RESULT";
      jobId: number;
      status: "done" | "failed";
      resultUrl?: string;
      error?: string;
    }
  | { type: "FETCH_IMAGE"; url: string } // creator-publish -> bg（抓图绕 CORS）
  // --- 归因任务管道 ---
  | { type: "GALAXY_DATA"; detail: GalaxyEventDetail } // creator-tasks -> bg（按 sender.tab 归任务）
  | { type: "TASK_DATA"; taskId: number; data: unknown } // content.ts（带 __v2m_task 标记的 www 页）
  // --- site-bridge 转发（只允许工作台 origin）---
  | { type: "SITE_PING" }
  | { type: "SITE_SET_AUTH"; apiBase: string; token: string }
  | { type: "SITE_SYNC_ACCOUNTS" }
  | { type: "SITE_COLLECT_URL"; url: string }
  | { type: "TRUSTED_CLICK"; x: number; y: number } // content -> bg：debugger 真实点击开详情弹窗
  | { type: "SITE_RUN_PUBLISH_JOB"; jobId: number }
  // --- popup 采集库下拉 ---
  | { type: "LIST_COLLECTIONS" }
  | { type: "CREATE_COLLECTION"; name: string };

export interface BgResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

export async function sendToBackground<T = unknown>(msg: BgMessage): Promise<T> {
  let resp: BgResponse<T> | undefined;
  try {
    resp = (await chrome.runtime.sendMessage(msg)) as BgResponse<T> | undefined;
  } catch {
    throw new Error("插件后台未响应，请重新加载插件");
  }
  if (!resp) throw new Error("插件后台未响应，请重新加载插件");
  if (!resp.ok) throw new Error(resp.error ?? "请求失败");
  return resp.data as T;
}
