/**
 * MV3 service worker：
 *  - storage.local.auth = {apiBase, token}（SITE_SET_AUTH 写入，校验来源 origin）
 *  - api() 封装带 Authorization 的服务端请求（401 自动清授权）
 *  - alarms 每 5min 探测小红书登录态（已打开 tab 的 __INITIAL_STATE__.user，
 *    兜底读 cookie web_session/a1）→ POST /api/ext/accounts/heartbeat
 *  - alarms 每 1min 轮询 GET /api/ext/publish/pending → claim → 开
 *    creator.xiaohongshu.com/publish/publish?job_id=N → tabs.onUpdated 后
 *    sendMessage JOB_PAYLOAD 给 creator-publish 脚本；结果经 JOB_RESULT 回传
 */

import type {
  AccountHeartbeat,
  CollectResponse,
  CollectionTaskClaim,
  ExtTask,
  PendingPublishJobsResponse,
  PendingTasksResponse,
  PublishOutcome,
  BrowserExecutionLease,
} from "@v2media/shared";
import {
  isAuthError,
  metricsRowsFromResponse,
  personalInfoFromResponse,
  postedNotesFromResponse,
  BROWSER_EXECUTION_CAPABILITY,
} from "@v2media/shared";
import type {
  BgMessage,
  BgResponse,
  GalaxyEventDetail,
  LoginState,
  PublishJobPayload,
} from "./lib/messages";
import { getSettings, setSettings } from "./lib/settings";
import { BrowserLane } from "./lib/browser-lane";
import { KeywordRunner } from "./lib/keyword-runner";
import { COLLECTION_CAPABILITY, type CollectionPageSnapshot } from "@v2media/shared";
import { ExecutionStore, type BrowserExecution, type ExecutionContext, type ResultReceipt } from "./lib/execution-store";

const VERSION = chrome.runtime.getManifest().version;
const browserLane = new BrowserLane();
const executionStore = new ExecutionStore();
let recoveryBlocked: string | null = null;
interface CollectionSafetyBlock {
  taskId: number; leaseId: string; revision?: number; tabId?: number;
  context?: ExecutionContext; reason?: string; pendingFinish?: Record<string, unknown>;
}
class BrowserBusyError extends Error { constructor() { super("浏览器正在执行其他任务，请稍后重试或先暂停自动采集"); } }

async function collectionSafetyReady() {
  const block = (await chrome.storage.local.get("collectionSafetyBlock")).collectionSafetyBlock as CollectionSafetyBlock | undefined;
  if (!block) return true;
  if (!block.context || !(await matchesContext(block.context))) return false;
  try {
    const state = await api<{ task: { status: string; controlRevision: number; lastControlAction: "pause" | "resume" | "cancel" | null } }>(`/api/collection-tasks/${block.taskId}`, {}, block.context);
    // Lease expiry also changes revision: only an explicit control action may release a verification stop.
    if (block.revision === undefined || state.task.controlRevision <= block.revision ||
        !["resume", "cancel"].includes(state.task.lastControlAction ?? "")) return false;
  } catch { return false; }
  await chrome.storage.local.remove("collectionSafetyBlock");
  if (block.tabId) await chrome.tabs.remove(block.tabId).catch(() => {});
  await executionStore.remove("keyword", block.taskId);
  for (const r of await executionStore.receipts()) if (r.kind === "keyword" && r.id === block.taskId) await executionStore.ack(r.key);
  return true;
}
async function reserveBrowser(owner: string) {
  await reconcileBrowserExecutions();
  if (browserLane.owns(owner)) return true;
  if (recoveryBlocked) return false;
  if (!browserLane.acquire(owner)) return false;
  try {
    if (!(await collectionSafetyReady())) { browserLane.release(owner); return false; }
    const finished = ((await chrome.storage.session.get("finishedPublishJobs")).finishedPublishJobs ?? []) as number[];
    for (const tab of await chrome.tabs.query({ url: "*://*.xiaohongshu.com/*" })) {
      if (!tab.url) continue; const u = new URL(tab.url);
      if (u.searchParams.has("__v2m_collect_task")) {
        browserLane.release(owner); return false;
      }
      const job = u.searchParams.get("job_id"), task = u.searchParams.get("__v2m_task");
      const same = job ? owner === `publish:${job}` : task ? owner === `task:${task}` : u.searchParams.has("__v2m_collect") ? owner === `collect:${u.pathname.match(/[0-9a-f]{24}/i)?.[0] ?? "manual"}` : false;
      if (!same && ((job && !finished.includes(Number(job))) || task || u.searchParams.has("__v2m_collect"))) { browserLane.release(owner); return false; }
    }
    return true;
  } catch (e) { browserLane.release(owner); throw e; }
}

/**
 * 认领标识：storage.local 持久 → Chrome 重启后仍保留认领方
 * （GET /publish/:id?claimer= 校验用）；换浏览器则 id 不同，防止重复执行 running 任务。
 */
let loadingSwId: Promise<string> | null = null;
async function swId(): Promise<string> {
  if (!loadingSwId) loadingSwId = (async () => {
    const { swId } = (await chrome.storage.local.get("swId")) as { swId?: string };
    if (swId) return swId;
    const id = `${VERSION}-${crypto.randomUUID()}`;
    await chrome.storage.local.set({ swId: id }); return id;
  })();
  return loadingSwId;
}

interface ExtAuth {
  apiBase: string;
  token: string;
  epoch: string;
}

interface TrackedJob {
  jobId: number;
  tabId?: number;
  state: "opening" | "running" | "done" | "failed";
  openedAt: number;
  deadline: number;
  payload: PublishJobPayload;
  execution: BrowserExecution;
}

let loadingAuth: Promise<ExtAuth | null> | null = null;
async function getAuth(): Promise<ExtAuth | null> {
  if (loadingAuth) return loadingAuth;
  loadingAuth = (async () => {
    const { auth } = await chrome.storage.local.get("auth");
    if (!auth) return null;
    if (!auth.epoch) { auth.epoch = crypto.randomUUID(); await chrome.storage.local.set({ auth }); }
    return auth as ExtAuth;
  })();
  try { return await loadingAuth; } finally { loadingAuth = null; }
}
async function authContext(): Promise<ExecutionContext> {
  const auth = await getAuth(); if (!auth) throw new NotAuthorizedError();
  return { apiBase: auth.apiBase, epoch: auth.epoch };
}
async function matchesContext(context: ExecutionContext) {
  const auth = await getAuth(); return !!auth && auth.apiBase === context.apiBase && auth.epoch === context.epoch;
}

function defaultAppOrigin(): string | null {
  const cs = chrome.runtime
    .getManifest()
    .content_scripts?.find((c) => c.js?.includes("site-bridge.js"));
  const pattern = cs?.matches?.[0];
  return pattern ? pattern.replace(/\/\*$/, "") : null;
}

class NotAuthorizedError extends Error {
  constructor(message = "插件未授权：请打开工作台，点击「授权插件」") {
    super(message);
  }
}

class ApiError extends Error { constructor(message: string, readonly status: number) { super(message); } }
async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, context?: ExecutionContext): Promise<T> {
  const auth = await getAuth();
  if (!auth) throw new NotAuthorizedError();
  if (context && (context.apiBase !== auth.apiBase || context.epoch !== auth.epoch)) throw new NotAuthorizedError("执行属于之前的授权，需要原账号核对");
  const res = await fetch(`${auth.apiBase}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${auth.token}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (context && !(await matchesContext(context))) throw new NotAuthorizedError("执行期间授权已变化，结果保留待核对");
  if (res.status === 401) {
    if (await matchesContext({ apiBase: auth.apiBase, epoch: auth.epoch })) await chrome.storage.local.remove("auth");
    throw new NotAuthorizedError("插件授权已失效，请在工作台重新「授权插件」");
  }
  if (!res.ok) throw new ApiError((data?.error as string) ?? `服务端错误 HTTP ${res.status}`, res.status);
  return data as T;
}

// ---------- 心跳：登录态探测 ----------

interface DetectedAccount {
  xhsUserId: string;
  nickname: string;
  avatar: string;
  subType: "pc" | "creator";
  status: "online" | "expired";
  statusMessage?: string;
}

/** 找一个已打开的小红书 tab 问 content script 要 __INITIAL_STATE__.user。 */
async function accountFromOpenTab(): Promise<DetectedAccount | null> {
  const tabs = await chrome.tabs.query({
    url: ["https://www.xiaohongshu.com/*", "https://xiaohongshu.com/*"],
  });
  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const resp = (await chrome.tabs.sendMessage(tab.id, {
        type: "GET_LOGIN_STATE",
      })) as BgResponse<LoginState> | undefined;
      if (!resp?.ok || !resp.data) continue;
      const s = resp.data;
      if (s.loggedIn && s.userId) {
        return {
          xhsUserId: s.userId,
          nickname: s.nickname,
          avatar: s.avatar,
          subType: "pc",
          status: "online",
          statusMessage: "插件心跳正常",
        };
      }
      return {
        xhsUserId: "",
        nickname: "",
        avatar: "",
        subType: "pc",
        status: "expired",
        statusMessage: "页面显示未登录",
      };
    } catch {
      // 该 tab 还没注入 content script，换下一个
    }
  }
  return null;
}

/** 无可用 tab 时读 cookie：web_session 在 = 登录态大概还活着。 */
async function accountFromCookies(): Promise<DetectedAccount | null> {
  const [session, a1] = await Promise.all([
    chrome.cookies.get({ url: "https://www.xiaohongshu.com", name: "web_session" }),
    chrome.cookies.get({ url: "https://www.xiaohongshu.com", name: "a1" }),
  ]);
  if (!a1 && !session) return null;
  const { lastAccount } = (await chrome.storage.local.get("lastAccount")) as {
    lastAccount?: DetectedAccount;
  };
  if (session && lastAccount?.xhsUserId) {
    return { ...lastAccount, status: "online", statusMessage: "cookie 存活（未打开页面）" };
  }
  return {
    xhsUserId: lastAccount?.xhsUserId ?? "",
    nickname: lastAccount?.nickname ?? "",
    avatar: lastAccount?.avatar ?? "",
    subType: "pc",
    status: session ? "online" : "expired",
    statusMessage: session ? "cookie 存活（页面未打开，账号信息未知）" : "web_session 已失效",
  };
}

async function heartbeat() {
  if (!(await getSettings()).enabled) return; // 总开关关闭：不上报心跳
  const auth = await getAuth();
  if (!auth) return;
  const detected = (await accountFromOpenTab()) ?? (await accountFromCookies());
  if (!detected) return; // 从未见过账号且 cookie 也没有，不上报
  if (detected.xhsUserId && detected.status === "online") {
    await chrome.storage.local.set({ lastAccount: detected });
  }
  if (!detected.xhsUserId && detected.status === "expired") {
    // 拿不到当前 id：用上次心跳记住的账号 id 标 expired，服务端才能下线它
    const { lastAccount } = (await chrome.storage.local.get("lastAccount")) as {
      lastAccount?: DetectedAccount;
    };
    if (!lastAccount?.xhsUserId) return;
    detected.xhsUserId = lastAccount.xhsUserId;
    detected.nickname = lastAccount.nickname;
    detected.avatar = lastAccount.avatar;
  }
  const payload: AccountHeartbeat = { accounts: detected.xhsUserId ? [detected] : [] };
  if (!payload.accounts.length) return;
  await api("/api/ext/accounts/heartbeat", { body: payload }).catch((e) => {
    console.warn("[v2m] heartbeat failed:", e);
  });
}

// ---------- 发布任务轮询/派发 ----------

const trackedJobs = new Map<number, TrackedJob>();
const JOB_TIMEOUT_MS = 10 * 60 * 1000;

async function fetchPendingJobs(includeFuture = false): Promise<PublishJobPayload[]> {
  // 带上当前登录号做服务端过滤：不匹配的任务不占 limit 名额（防饿死）
  const account = await currentXhsUserId();
  const qs = [includeFuture ? "all=1" : "", account ? `account=${encodeURIComponent(account)}` : ""]
    .filter(Boolean)
    .join("&");
  const res = await api<PendingPublishJobsResponse>(
    `/api/ext/publish/pending${qs ? `?${qs}` : ""}`,
  );
  return res.jobs ?? [];
}

let _curAccountCache: { id: string; at: number } | null = null;

/** claim 前的实时账号身份：开着的 xhs tab → 抓首页 __INITIAL_STATE__ → 上次心跳。60s 内复用结果，避免轮询反复抓首页。 */
async function currentXhsUserId(fresh = false): Promise<string> {
  if (!fresh && _curAccountCache && Date.now() - _curAccountCache.at < 60_000) {
    return _curAccountCache.id;
  }
  const id = await resolveXhsUserId(!fresh);
  _curAccountCache = { id, at: Date.now() };
  return id;
}

async function resolveXhsUserId(allowLastKnown = true): Promise<string> {
  const tab = await accountFromOpenTab();
  if (tab?.xhsUserId) return tab.xhsUserId;
  try {
    const res = await fetch("https://www.xiaohongshu.com/", { credentials: "include" });
    if (res.ok) {
      const html = await res.text();
      // 只认 userId（24 位 hex）；red_id 是「小红书号」，拿它过滤任务一条都匹配不上（任务被晾好几分钟）
      const m = html.match(/"user(?:I|_i)nfo"\s*:\s*\{[^}]*?"(?:userId|user_id)"\s*:\s*"([0-9a-f]{24})"/i);
      if (m?.[1]) return m[1];
    }
  } catch {
    // 抓不到就落到 lastAccount
  }
  if (!allowLastKnown) return "";
  const { lastAccount } = (await chrome.storage.local.get("lastAccount")) as {
    lastAccount?: DetectedAccount;
  };
  return lastAccount?.xhsUserId ?? "";
}

/** 任务指定了托管账号时，当前浏览器登录的小红书号必须一致；校验不了就失败关闭（不发错账号）。 */
async function accountMismatch(job: PublishJobPayload): Promise<string | null> {
  const want = job.xhsUserId;
  if (!want) return null;
  const cur = await currentXhsUserId();
  if (!cur) return `任务绑定账号 ${want}，当前浏览器登录态不可验证`;
  return cur === want
    ? null
    : `任务绑定账号 ${want}，当前浏览器登录 ${cur}`;
}

function leaseFrom(value: unknown): BrowserExecutionLease {
  const v = value as Partial<BrowserExecutionLease>;
  if (!v?.leaseId || !v.claimedBy || !Number.isInteger(v.attempt) || !v.leaseUntil) throw new Error("服务端没有返回执行租约，请更新服务端后重试");
  return v as BrowserExecutionLease;
}
function leaseBody(record: BrowserExecution) {
  if (!record.lease) throw new Error("执行租约缺失，需要核对");
  const { claimedBy, leaseId, attempt } = record.lease;
  return { capability: BROWSER_EXECUTION_CAPABILITY, claimedBy, leaseId, attempt };
}
async function clearExecution(record: BrowserExecution) {
  if (!(await executionStore.remove(record.kind, record.id, record))) return;
  if (record.kind === "task" && record.tabId) await currentXhsUserId();
  if (record.tabId) await chrome.tabs.remove(record.tabId).catch(() => {});
  if (record.kind === "publish") trackedJobs.delete(record.id);
  if (record.kind === "task") trackedTasks.delete(record.id);
  browserLane.release(`${record.kind}:${record.id}`);
}
async function transmitReceipt(receipt: ResultReceipt) {
  await api(receipt.path, { body: receipt.body }, receipt.context);
  // ACK is the only success path that removes execution state and its owned tab.
  const record = (await executionStore.executions()).find(r => r.kind === receipt.kind && r.id === receipt.id &&
    r.context.epoch === receipt.context.epoch && r.context.apiBase === receipt.context.apiBase &&
    (receipt.kind === "keyword" ? (r.payload as { leaseId?: string }).leaseId === receipt.body.leaseId : r.lease?.leaseId === receipt.body.leaseId));
  if (record && receipt.kind !== "keyword") await clearExecution(record);
  if (record && receipt.kind === "keyword" && receipt.body.outcome !== "blocked") await clearExecution(record);
  await executionStore.ack(receipt.key);
}
async function queueResult(record: BrowserExecution, body: Record<string, unknown>) {
  const key = `${record.kind}:${record.id}:${record.lease?.leaseId ?? "legacy"}`;
  const receipt = await executionStore.enqueue({ key, kind: record.kind, id: record.id, context: record.context,
    path: `/api/ext/${record.kind === "publish" ? "publish" : "tasks"}/${record.id}/result`,
    body: { ...body, ...leaseBody(record), receiptId: crypto.randomUUID() } });
  record.phase = "awaiting_ack"; await executionStore.put(record);
  await transmitReceipt(receipt);
}
let reconciling: Promise<void> | null = null;
let keywordContext: ExecutionContext | null = null;
async function reconcileBrowserExecutions() {
  if (reconciling) return reconciling;
  reconciling = reconcileExecutions();
  try { await reconciling; } finally { reconciling = null; }
}
async function reconcileExecutions() {
  recoveryBlocked = null;
  const auth = await getAuth(); if (!auth) { recoveryBlocked = "插件未授权"; return; }
  await collectionSafetyReady();
  for (const receipt of await executionStore.receipts()) {
    if (!(await matchesContext(receipt.context))) { recoveryBlocked = "之前授权的执行结果尚待核对"; continue; }
    try { await transmitReceipt(receipt); }
    catch (e) {
      if (e instanceof ApiError && [404, 409].includes(e.status)) {
        const record = (await executionStore.executions()).find(r => r.kind === receipt.kind && r.id === receipt.id);
        if (receipt.kind === "task" && record) { await clearExecution(record); await executionStore.ack(receipt.key); continue; }
        // A rejected publish receipt cannot prove that no note was posted.
        if (record && receipt.kind === "publish") { record.phase = "uncertain"; await executionStore.put(record); }
      }
      recoveryBlocked = "执行结果等待服务端确认";
    }
  }
  const tabs = await chrome.tabs.query({ url: "*://*.xiaohongshu.com/*" });
  const block = (await chrome.storage.local.get("collectionSafetyBlock")).collectionSafetyBlock as CollectionSafetyBlock | undefined;
  for (const record of await executionStore.executions()) {
    if (!(await matchesContext(record.context))) {
      record.phase = "authorization_changed"; await executionStore.put(record);
      recoveryBlocked = "执行属于之前的授权，请使用原账号核对"; continue;
    }
    if (record.phase === "awaiting_ack") { recoveryBlocked = "执行结果等待服务端确认"; continue; }
    if (record.phase === "uncertain" || record.phase === "authorization_changed") { recoveryBlocked = "发布结果不明确，需要核对"; continue; }
    if (record.kind === "keyword") {
      if (keywordContext || block?.taskId === record.id) continue;
      // Read-only collection pages may be retired before priority dispatch, including a replaced lease.
      try {
        await api(`/api/ext/collection-tasks/${record.id}/finish`, { body: { ...(record.payload as object), outcome: "yield", reason: "插件重启，恢复服务端进度" } }, record.context);
      } catch (e) { if (!(e instanceof ApiError && [404, 409].includes(e.status))) { recoveryBlocked = "采集恢复等待网络"; continue; } }
      await clearExecution(record); continue;
    }
    const tracked = record.kind === "publish" ? trackedJobs.get(record.id) : trackedTasks.get(record.id);
    if (tracked) continue;
    let remote: (PublishJobPayload | ExtTask) & Partial<BrowserExecutionLease>;
    try {
      if (!record.lease?.claimedBy) throw new Error("原认领身份缺失，执行需要核对");
      remote = await api(`/api/ext/${record.kind === "publish" ? "publish" : "tasks"}/${record.id}?claimer=${encodeURIComponent(record.lease.claimedBy)}&capability=${BROWSER_EXECUTION_CAPABILITY}`, {}, record.context);
    } catch (e) {
      if (record.kind === "task" && e instanceof ApiError && [404, 409].includes(e.status)) { await clearExecution(record); continue; }
      recoveryBlocked = "发布执行状态尚未核对"; continue;
    }
    if (["done", "failed", "canceled"].includes(remote.status ?? "")) { await clearExecution(record); continue; }
    if (["pending", "queued"].includes(remote.status ?? "")) {
      if (record.kind === "task") { await clearExecution(record); continue; }
      record.phase = "uncertain"; await executionStore.put(record); recoveryBlocked = "发布状态发生变化，需要人工核对"; continue;
    }
    const lease = leaseFrom(remote);
    if (lease.leaseId !== record.lease?.leaseId || lease.attempt !== record.lease.attempt) {
      if (record.kind === "task") { await clearExecution(record); continue; }
      recoveryBlocked = "发布租约已变化，需要核对"; continue;
    }
    record.lease = lease;
    let ownedTab = tabs.find(t => t.id === record.tabId);
    if (!ownedTab && record.kind === "publish" && !record.delivered) {
      const candidates = tabs.filter(t => t.url && new URL(t.url).searchParams.get("__v2m_execution") === record.lease?.leaseId);
      if (candidates.length === 1) { ownedTab = candidates[0]; record.tabId = ownedTab!.id; }
    }
    if (record.kind === "publish") {
      if (!ownedTab) {
        record.phase = "uncertain"; await executionStore.put(record);
        recoveryBlocked = "发布页已关闭，执行结果未知，请核对"; continue;
      }
      if (!browserLane.acquire(`publish:${record.id}`) && !browserLane.owns(`publish:${record.id}`)) { recoveryBlocked = "存在多个未完成执行"; continue; }
      trackedJobs.set(record.id, { jobId: record.id, tabId: record.tabId, state: record.delivered ? "running" : "opening",
        openedAt: Date.now(), deadline: record.deadline, payload: record.payload as PublishJobPayload, execution: record });
    } else {
      if (!browserLane.acquire(`task:${record.id}`) && !browserLane.owns(`task:${record.id}`)) { recoveryBlocked = "存在多个未完成执行"; continue; }
      if (!ownedTab) {
        const url = taskTabUrl(remote as ExtTask); if (!url) { await clearExecution(record); continue; }
        const tab = await chrome.tabs.create({ url, active: false }); record.tabId = tab.id;
      }
      trackedTasks.set(record.id, { taskId: record.id, tabId: record.tabId, type: (remote as ExtTask).type,
        deadline: record.deadline, payload: (remote as ExtTask).payload as Record<string, unknown>, sawGalaxy: false,
        loginSuspected: false, done: false, execution: record });
    }
    await executionStore.put(record);
  }
  // URL markers identify cleanup candidates; a live execution record is the authority to resume them.
  const records = await executionStore.executions();
  for (const tab of tabs) {
    if (!tab.id || !tab.url || records.some(r => r.tabId === tab.id) || block?.tabId === tab.id) continue;
    const u = new URL(tab.url);
    const job = u.searchParams.get("job_id");
    if (job) {
      try {
        const remote = await api<{ status: string }>(`/api/ext/publish/${Number(job)}?claimer=${encodeURIComponent(await swId())}&capability=${BROWSER_EXECUTION_CAPABILITY}`);
        if (["done", "failed", "canceled"].includes(remote.status)) { await chrome.tabs.remove(tab.id).catch(() => {}); continue; }
      } catch { /* Lack of a durable owner remains an explicit reconciliation stop. */ }
      recoveryBlocked = "旧发布页没有可靠执行记录，请人工核对并关闭"; continue;
    }
    if (u.searchParams.has("__v2m_task") || u.searchParams.has("__v2m_collect_task")) {
      if (block && (u.searchParams.get("__v2m_lease") === block.leaseId || isChallengeUrl(tab.url))) continue;
      await currentXhsUserId();
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
  }
}

async function claimAndOpen(job: PublishJobPayload): Promise<boolean> {
  if (trackedJobs.has(job.id)) return true;
  const mismatch = await accountMismatch(job);
  if (mismatch) {
    console.warn(`[v2m] job ${job.id} skipped: ${mismatch}`);
    return false;
  }
  if (!(await reserveBrowser(`publish:${job.id}`))) throw new BrowserBusyError();
  try {
  const context = await authContext();
  const lease = leaseFrom(await api(`/api/ext/publish/${job.id}/claim`, { body: { capability: BROWSER_EXECUTION_CAPABILITY, claimedBy: await swId() } }, context));
  const execution: BrowserExecution = { kind: "publish", id: job.id, context, lease, payload: job, deadline: Date.now() + JOB_TIMEOUT_MS, phase: "opening" };
  await executionStore.put(execution);
  const tracked: TrackedJob = {
    jobId: job.id,
    state: "opening",
    openedAt: Date.now(),
    deadline: Date.now() + JOB_TIMEOUT_MS,
    payload: job,
    execution,
  };
  trackedJobs.set(job.id, tracked);
  const tab = await chrome.tabs.create({
    url: `https://creator.xiaohongshu.com/publish/publish?job_id=${job.id}&__v2m_execution=${lease.leaseId}`,
    active: false,
  });
  tracked.tabId = tab.id;
  execution.tabId = tab.id; await executionStore.put(execution);
  return true;
  } catch (e) { browserLane.release(`publish:${job.id}`); trackedJobs.delete(job.id); throw e; }
}

async function pollPendingJobs() {
  // 超时兜底先做：停用期间也要回收卡死的已认领任务，不随总开关停
  for (const [id, t] of trackedJobs) {
    if ((t.state === "opening" || t.state === "running") && Date.now() > t.deadline) {
      // Silence cannot prove the irreversible platform action failed. Keep the evidence and
      // the server claim intact; a timeout must never manufacture a retryable failed publish.
      t.execution.phase = "uncertain";
      await executionStore.put(t.execution);
      recoveryBlocked = `发布任务 #${id} 超时，结果未知，请核对站点；不会自动重发`;
    }
  }
  if (!(await getSettings()).enabled) return; // 总开关关闭：不领发布任务
  if (browserLane.busy || recoveryBlocked || !(await collectionSafetyReady())) return;
  const auth = await getAuth();
  if (!auth) return;
  let jobs: PublishJobPayload[];
  try {
    jobs = await fetchPendingJobs();
  } catch (e) {
    console.warn("[v2m] pending jobs poll failed:", e);
    return;
  }
  for (const job of jobs) {
    if (job.status !== "pending" || trackedJobs.has(job.id)) continue;
    try {
      if (await claimAndOpen(job)) break;
    } catch (e) {
      console.warn(`[v2m] claim job ${job.id} failed:`, e);
    }
  }
}

async function payloadForJob(jobId: number, tabId?: number): Promise<PublishJobPayload> {
  // 总开关关：JOB_READY / 手动打开发布页 / tabs.onUpdated 推 payload 都从这里进，先拦住
  if (!(await getSettings()).enabled) throw new Error("插件已停用");
  // 已认领的任务优先用内存里的 payload（pending 列表不再返回它）。
  await reconcileBrowserExecutions();
  const tracked = trackedJobs.get(jobId);
  if (tracked) {
    if (tabId === undefined || tracked.tabId !== tabId) throw new Error("发布页与执行记录不匹配");
    if (!(await matchesContext(tracked.execution.context))) throw new NotAuthorizedError("此发布属于之前的授权");
    if (tracked.execution.delivered) throw new Error("发布任务已开始；重新加载后请核对结果，不能再次执行");
    tracked.execution.delivered = true; tracked.execution.phase = "running";
    await executionStore.put(tracked.execution); return tracked.payload;
  }
  // 未认领（手动打开 ?job_id=N 或 SW 重启丢了状态）：单条接口能恢复 pending/running 任务
  const job = await api<PublishJobPayload>(
    `/api/ext/publish/${jobId}?claimer=${encodeURIComponent(await swId())}&capability=${BROWSER_EXECUTION_CAPABILITY}`,
  );
  if (!job) throw new Error(`服务端没有 job ${jobId} 的待发布任务`);
  if (job.status !== "pending") throw new Error("发布任务没有本地执行记录，不能重复执行；请先核对站点");
  if (!tabId) throw new Error("发布任务必须绑定标签页");
  // A manually opened pending page may claim only when no durable unknown execution exists.
  const previousBlock = recoveryBlocked; recoveryBlocked = null;
  const tabs = await chrome.tabs.query({ url: "*://*.xiaohongshu.com/*" });
  const senderTab = tabs.find(t => t.id === tabId);
  if (!senderTab?.url || new URL(senderTab.url).hostname !== "creator.xiaohongshu.com" || new URL(senderTab.url).searchParams.get("job_id") !== String(job.id)) throw new Error("发布页标记与任务不匹配");
  if ((await executionStore.executions()).length || tabs.some(t => t.id !== tabId && /job_id=|__v2m_task=|__v2m_collect_task=/.test(t.url ?? "")) || !(await collectionSafetyReady())) { recoveryBlocked = previousBlock; throw new BrowserBusyError(); }
  const mismatch = await accountMismatch(job); if (mismatch) throw new Error(mismatch);
  // This pending page is the current sender, so its marker may reserve its own owner.
  if (!browserLane.acquire(`publish:${job.id}`)) throw new BrowserBusyError();
  try {
  // Run Now 标记持久在 storage.session：SW 重启后恢复 payload 时重新覆盖掉原定时
  const runNowKey = `runNow:${job.id}`;
  if ((await chrome.storage.session.get(runNowKey))[runNowKey]) {
    job.scheduledAt = undefined;
  }
  const context = await authContext();
  const lease = leaseFrom(await api(`/api/ext/publish/${job.id}/claim`, { body: { capability: BROWSER_EXECUTION_CAPABILITY, claimedBy: await swId() } }, context));
  const execution: BrowserExecution = { kind: "publish", id: job.id, context, lease, tabId, delivered: true,
    phase: "running", deadline: Date.now() + JOB_TIMEOUT_MS, payload: job };
  await executionStore.put(execution);
  trackedJobs.set(job.id, {
    jobId: job.id,
    state: "running",
    openedAt: Date.now(),
    deadline: Date.now() + JOB_TIMEOUT_MS,
    payload: job,
    tabId,
    execution,
  });
  return job;
  } catch (e) { browserLane.release(`publish:${job.id}`); throw e; }
}

async function runPublishJobById(jobId: number) {
  // 工作台 Run Now 也是任务入口，跟轮询一样受总开关约束
  if (!(await getSettings()).enabled) throw new Error("插件已停用");
  const job =
    (await fetchPendingJobs(true).then((js) => js.find((j) => j.id === jobId))) ??
    (await api<PublishJobPayload>(
      `/api/ext/publish/${jobId}?claimer=${encodeURIComponent(await swId())}&capability=${BROWSER_EXECUTION_CAPABILITY}`,
    ).catch(() => null));
  if (!job) throw new Error(`任务 ${jobId} 不在待发布列表（可能已被认领/执行）`);
  job.scheduledAt = undefined; // Run Now 语义：忽略定时，立即发
  await chrome.storage.session.set({ [`runNow:${jobId}`]: true }); // SW 重启后仍生效
  const opened = await claimAndOpen(job);
  if (!opened) throw new Error(`任务 ${jobId} 绑定的是另一个托管账号，当前浏览器登录号不匹配`);
  return { opened: true, jobId };
}

// ---------- 归因任务管道（readback / metrics / account_snapshot） ----------
//
// 服务端 jobs 表调度到期任务；插件认领后在后台开 creator/www 页面、
// 嗅探页面自身发出的 galaxy/feed 响应回填。频控纪律（借 Easel 教训：
// 小红书节流的是读取）——任务严格串行、开页间隔 ≥20s、超时回收。

interface TrackedTask {
  taskId: number;
  type: string;
  tabId?: number;
  deadline: number;
  payload: Record<string, unknown>;
  sawGalaxy: boolean;
  loginSuspected: boolean;
  done: boolean;
  execution: BrowserExecution;
}
const trackedTasks = new Map<number, TrackedTask>();
const TASK_TIMEOUT_MS = 90_000;
const TASK_SPACING_MS = 20_000;
let lastTaskOpenAt = 0;

/** 各任务要打开的页面：readback/快照走创作中心，metrics 开笔记 www 详情页。 */
function taskTabUrl(task: ExtTask): string | null {
  const p = task.payload as Record<string, unknown>;
  let base: string;
  if (task.type === "metrics") {
    base =
      String(p.noteUrl ?? "") ||
      (p.noteId ? `https://www.xiaohongshu.com/explore/${p.noteId}` : "");
  } else if (task.type === "readback") {
    base = "https://creator.xiaohongshu.com/new/note-manager";
  } else if (task.type === "account_snapshot") {
    base = "https://creator.xiaohongshu.com/new/home";
  } else {
    return null;
  }
  if (!base) return null;
  return `${base}${base.includes("?") ? "&" : "?"}__v2m_task=${task.id}`;
}

/** 该任务是不是需要"当前浏览器登录的就是这个号"（metrics 读公开页不需要）。 */
function needsAccountMatch(type: string): boolean {
  return type === "readback" || type === "account_snapshot";
}

async function finishTask(
  t: TrackedTask,
  body: { status: "done" | "failed"; outcome?: PublishOutcome; data?: unknown; error?: string },
) {
  if (t.done) return;
  t.done = true;
  await queueResult(t.execution, body).catch((e) => {
    console.warn(`[v2m] task ${t.taskId} result report failed:`, e);
  });
}

/** galaxy 响应 → 该任务要的数据（不匹配返回 null 继续等）。 */
function galaxyDataForTask(
  t: TrackedTask,
  detail: GalaxyEventDetail,
): { data?: unknown; outcome?: PublishOutcome } | null {
  if (isAuthError(detail.json, detail.httpStatus)) return { outcome: "login_required" };
  if (t.type === "readback" && detail.path.includes("/creator/note/user/posted")) {
    return { data: { items: postedNotesFromResponse(detail.json) } };
  }
  if (t.type === "metrics" && detail.path.includes("analyze")) {
    return { data: { rows: metricsRowsFromResponse(detail.json) } };
  }
  if (t.type === "account_snapshot" && detail.path.includes("personal_info")) {
    return { data: personalInfoFromResponse(detail.json) };
  }
  return null;
}

async function pollTasks() {
  const now = Date.now();
  // 超时回收：登录疑似 → readback 定档 login_required；其余 → failed（服务端按需重排）
  for (const t of trackedTasks.values()) {
    if (t.done || now <= t.deadline) continue;
    if (t.type === "readback" && (t.loginSuspected || !t.sawGalaxy)) {
      // 创作中心登录态正常时页面必发 galaxy 请求；完全没有基本等于被踢去登录页
      await finishTask(t, { status: "done", outcome: "login_required" });
    } else {
      await finishTask(t, { status: "failed", error: "任务执行超时" });
    }
  }
  if (!(await getSettings()).enabled) return; // 总开关关：不领任务
  if (browserLane.busy || recoveryBlocked || !(await collectionSafetyReady())) return;
  if (!(await getAuth())) return;
  let tasks: ExtTask[];
  try {
    tasks = (await api<PendingTasksResponse>("/api/ext/tasks/pending?limit=5")).tasks ?? [];
  } catch (e) {
    console.warn("[v2m] pending tasks poll failed:", e);
    return;
  }
  for (const task of tasks) {
    if (trackedTasks.has(task.id)) continue;
    const want = String((task.payload as Record<string, unknown>)?.xhsUserId ?? "");
    if (want && needsAccountMatch(task.type)) {
      const cur = await currentXhsUserId();
      // 登录对不上就不领：留给登录该账号的浏览器跑（任务继续 pending，不判失败）
      if (!cur || cur !== want) continue;
    }
    // 串行 + 间隔：一轮最多领一个（下一个等下一分钟轮询）
    if (now - lastTaskOpenAt < TASK_SPACING_MS) break;
    if (!(await reserveBrowser(`task:${task.id}`))) break;
    let lease: BrowserExecutionLease;
    const context = await authContext();
    try {
      lease = leaseFrom(await api(`/api/ext/tasks/${task.id}/claim`, { body: { capability: BROWSER_EXECUTION_CAPABILITY, claimedBy: await swId() } }, context));
    } catch {
      browserLane.release(`task:${task.id}`);
      continue;
    }
    const execution: BrowserExecution = { kind: "task", id: task.id, context, lease, deadline: now + TASK_TIMEOUT_MS, payload: task, phase: "opening" };
    await executionStore.put(execution);
    const url = taskTabUrl(task);
    if (!url) {
      await queueResult(execution, { status: "failed", error: `未知任务类型 ${task.type}` }).catch(() => {});
      continue;
    }
    const tracked: TrackedTask = {
      taskId: task.id,
      type: task.type,
      deadline: now + TASK_TIMEOUT_MS,
      payload: task.payload as Record<string, unknown>,
      sawGalaxy: false,
      loginSuspected: false,
      done: false,
      execution,
    };
    trackedTasks.set(task.id, tracked);
    lastTaskOpenAt = now;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tracked.tabId = tab.id;
      execution.tabId = tab.id; execution.phase = "running"; await executionStore.put(execution);
      break;
    } catch (e) {
      await finishTask(tracked, { status: "failed", error: String(e) });
    }
  }
}

// ---------- 消息路由 ----------

function reply<T>(p: Promise<T>, sendResponse: (r: BgResponse<T>) => void) {
  p.then(
    (data) => sendResponse({ ok: true, data }),
    (e) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) }),
  );
  return true; // async sendResponse
}

chrome.runtime.onMessage.addListener(
  (msg: BgMessage & Record<string, unknown>, sender, sendResponse) => {
    switch (msg?.type) {
      // --- content script 采集上报 ---
      case "EXT_COLLECT":
        return reply(
          getSettings()
            .then(async (s) => {
              // 停用中拒绝入库：报错而非假成功，content 侧会把未成功的批次塞回 pending
              if (!s.enabled) throw new Error("插件已停用");
              const owned = (await executionStore.executions()).find(r => r.tabId === sender.tab?.id);
              const tabContexts = ((await chrome.storage.local.get("collectionTabContexts")).collectionTabContexts ?? {}) as Record<string, ExecutionContext>;
              const context = owned?.context ?? [...collectWaiters.values()].find(w => w.tabId === sender.tab?.id)?.context ?? tabContexts[String(sender.tab?.id)];
              if (!context && /__v2m_collect|__v2m_task/.test(sender.tab?.url ?? sender.url ?? "")) throw new Error("自动任务页面缺少原授权上下文，等待恢复核对");
              return api<CollectResponse>("/api/ext/collect", { body: msg.batch }, context).catch(
                async (e) => {
                  // 所选库已被工作台删除：自愈回「不分组」并重试（批次不能丢）
                  if (!/collection not found/.test(String((e as Error)?.message ?? e))) throw e;
                  await setSettings({ collectionId: null });
                  const { collectionId: _drop, ...rest } = msg.batch;
                  return api<CollectResponse>("/api/ext/collect", {
                    body: { ...rest, collectionId: null },
                  }, context);
                },
              );
            })
            .then(async (r) => {
            const { stats } = (await chrome.storage.local.get("stats")) as {
              stats?: { collected?: number };
            };
            await chrome.storage.local.set({
              stats: { collected: (stats?.collected ?? 0) + (r.saved ?? 0) },
            });
            return r;
          }),
          sendResponse,
        );

      case "GET_STATUS":
        return reply(
          getAuth().then(async (auth) => {
            const { stats, lastDeepCollectFailure } = (await chrome.storage.local.get([
              "stats",
              "lastDeepCollectFailure",
            ])) as {
              stats?: { collected?: number };
              lastDeepCollectFailure?: { noteId: string; error: string; at: number };
            };
            return {
              version: VERSION,
              authorized: !!auth,
              appUrl: auth?.apiBase ?? defaultAppOrigin(),
              collected: stats?.collected ?? 0,
              lastDeepCollectFailure,
              execution: { owner: [...trackedJobs.keys()].map(id => `publish:${id}`)[0] ?? [...trackedTasks.keys()].map(id => `task:${id}`)[0] ?? (keywordContext ? "keyword" : null),
                blockedReason: recoveryBlocked ?? ((await chrome.storage.local.get("collectionSafetyBlock")).collectionSafetyBlock ? "采集验证需用户明确继续" : null),
                pendingReceipts: (await executionStore.receipts()).length,
                uncertain: (await executionStore.executions()).filter(r => ["uncertain", "authorization_changed"].includes(r.phase ?? "")).map(r => ({ kind: r.kind, id: r.id, phase: r.phase })) },
            };
          }),
          sendResponse,
        );

      // --- 发布链路 ---
      case "JOB_READY":
        return reply(
          payloadForJob(Number(msg.jobId), sender.tab?.id).then((payload) => {
            const t = trackedJobs.get(payload.id);
            if (t) t.state = "running";
            return { payload };
          }),
          sendResponse,
        );

      case "JOB_RESULT": {
        return reply(
          (async () => {
            await reconcileBrowserExecutions();
            const t = trackedJobs.get(msg.jobId);
            if (!t || sender.tab?.id !== t.tabId || !t.execution.delivered || !(await matchesContext(t.execution.context))) throw new Error("发布回执与当前执行不匹配");
            if (msg.status === "uncertain") {
              if (t.execution.phase !== "awaiting_ack") {
                t.execution.phase = "uncertain"; await executionStore.put(t.execution);
                recoveryBlocked = `发布任务 #${msg.jobId} 结果未知，请核对站点；不会自动重发`;
              }
              return { reported: true, reconciliationRequired: true };
            }
            await queueResult(t.execution, { status: msg.status, resultUrl: msg.resultUrl, error: msg.error });
            const previous = ((await chrome.storage.session.get("finishedPublishJobs")).finishedPublishJobs ?? []) as number[];
            await chrome.storage.session.set({ finishedPublishJobs: [...previous.filter(id => id !== msg.jobId), msg.jobId].slice(-100) });
            return { reported: true };
          })().then(r => { void dispatchBrowserWork(); return r; }),
          sendResponse,
        );
      }

      case "FETCH_IMAGE":
        return reply(fetchImageAsDataUrl(String(msg.url ?? "")), sendResponse);

      // --- 归因任务数据回传 ---
      case "GALAXY_DATA": {
        const tabId = sender.tab?.id;
        const detail = msg.detail as GalaxyEventDetail | undefined;
        if (tabId == null || !detail?.path) return false;
        for (const t of trackedTasks.values()) {
          if (t.tabId !== tabId || t.done) continue;
          t.sawGalaxy = true;
          const got = galaxyDataForTask(t, detail);
          if (!got) continue;
          if (got.outcome === "login_required") t.loginSuspected = true;
          if (t.type === "readback") {
            void finishTask(t, {
              status: "done",
              outcome: got.outcome,
              data: got.data,
            });
          } else if (got.data) {
            void finishTask(t, { status: "done", data: got.data });
          }
        }
        sendResponse({ ok: true });
        return false;
      }

      case "TASK_DATA": {
        const t = trackedTasks.get(Number(msg.taskId));
        if (t && sender.tab?.id === t.tabId && !t.done && t.type === "metrics" && msg.data) {
          void finishTask(t, { status: "done", data: { rows: [msg.data] } });
        }
        sendResponse({ ok: true });
        return false;
      }

      // --- COLLECT_URL 回执 ---
      case "COLLECT_URL_DONE": {
        const w = collectWaiters.get(msg.noteId ?? "");
        const sid = sender.tab?.id;
        // 回执必须来自本次任务开的那个页：SW 重启后旧页的回执不能顶替新页的 waiter
        if (w && (w.tabId === undefined || sid === undefined || w.tabId === sid)) {
          collectWaiters.delete(msg.noteId ?? "");
          clearCollectWaiterTimers(w);
          w.resolve({
            ok: msg.ok,
            noteId: msg.noteId,
            error: msg.error,
            detailCaptured: msg.detailCaptured,
            commentsCaptured: msg.commentsCaptured,
            imageCount: msg.imageCount,
          });
        } else if (sid) {
          // 旧生命周期的孤儿页回执（或 waiter 已失配）：采集页自己上传已完成，收掉发件页
          setTimeout(() => { void (async () => {
            const block = (await chrome.storage.local.get("collectionSafetyBlock")).collectionSafetyBlock as CollectionSafetyBlock | undefined;
            if (block?.tabId === sid) return;
            const tab = await chrome.tabs.get(sid).catch(() => null);
            if (tab?.url && new URL(tab.url).searchParams.get("__v2m_collect") === "1") await chrome.tabs.remove(sid).catch(() => {});
          })(); }, 1000);
        }
        sendResponse({ ok: true });
        return false;
      }
      case "COLLECT_URL_CHALLENGE": {
        const w = collectWaiters.get(msg.noteId ?? "");
        const sid = sender.tab?.id;
        if (w && sid && (w.tabId === undefined || w.tabId === sid)) {
          void onCollectChallenge(msg.noteId ?? "", w, sid);
        }
        sendResponse({ ok: true });
        return false;
      }
      case "COLLECT_URL_CHALLENGE_DONE": {
        const noteId = msg.noteId ?? "";
        const w = collectWaiters.get(noteId);
        const sid = sender.tab?.id;
        if (w && sid && (w.tabId === undefined || w.tabId === sid)) {
          onCollectChallengeCleared(noteId, w);
        }
        sendResponse({ ok: true });
        return false;
      }

      // --- site-bridge（工作台 origin 限定） ---
      case "SITE_PING":
        return reply(
          getAuth().then((auth) => ({ version: VERSION, authorized: !!auth, capabilities: [COLLECTION_CAPABILITY, BROWSER_EXECUTION_CAPABILITY] })),
          sendResponse,
        );
      case "SITE_SET_AUTH": {
        const origin =
          sender.origin ?? (sender.url ? new URL(sender.url).origin : "");
        const { apiBase, token } = msg;
        if (!token || typeof token !== "string" || typeof apiBase !== "string" || apiBase !== origin) {
          sendResponse({ ok: false, error: "授权来源不匹配" });
          return false;
        }
        return reply(
          (async () => {
            const old = await getAuth();
            const epoch = old?.apiBase === apiBase && old.token === token ? old.epoch : crypto.randomUUID();
            await chrome.storage.local.set({ auth: { apiBase, token, epoch } satisfies ExtAuth });
            _curAccountCache = null;
            await reconcileBrowserExecutions();
            void heartbeat();
            void dispatchBrowserWork();
            return { ok: true };
          })(),
          sendResponse,
        );
      }
      case "SITE_SYNC_ACCOUNTS":
        return reply(
          heartbeat().then(async () => {
            const { lastAccount } = (await chrome.storage.local.get("lastAccount")) as {
              lastAccount?: DetectedAccount;
            };
            return { account: lastAccount ?? null };
          }),
          sendResponse,
        );
      case "SITE_COLLECT_URL":
        return reply(collectByUrl(String(msg.url ?? "")), sendResponse);
      case "TRUSTED_CLICK":
        // 内容脚本的 .click() 是不可信事件，XHS 的弹窗 handler 会忽略；
        // 用 chrome.debugger 派发真实鼠标点击来打开笔记详情弹窗
        return reply(
          Promise.resolve(sender?.tab?.id).then(async (tid) => {
              if (tid == null || !(await getSettings()).enabled) return { ok: false };
              const execution = (await executionStore.executions()).find(r => r.tabId === tid);
              const collect = [...collectWaiters.entries()].find(([, w]) => w.tabId === tid);
              const owner = execution ? `${execution.kind}:${execution.id}` : collect?.[0];
              const owns = execution ? browserLane.owns(owner!) && await matchesContext(execution.context) && !["awaiting_ack", "uncertain", "authorization_changed"].includes(execution.phase ?? "")
                : !!owner && browserLane.owns(`collect:${owner}`) && !!collect?.[1].context && await matchesContext(collect[1].context);
              if (recoveryBlocked || (browserLane.busy && !owns)) return { ok: false, diag: "浏览器正在执行其他自动任务" };
              if (execution && !owns) return { ok: false, diag: "执行上下文已变化" };
              return await (async () => {
                  const diag: string[] = [];
                  const ok = await trustedClick(
                    tid,
                    Number(msg.x),
                    Number(msg.y),
                    Array.isArray(msg.selectors) ? msg.selectors.map(String) : undefined,
                    diag,
                    execution ? async () => {
                      if (execution.kind === "publish") {
                        const want = (execution.payload as PublishJobPayload).xhsUserId;
                        const current = await currentXhsUserId(true);
                        if (want && current !== want) throw new Error("浏览器小红书账号已变化或无法实时核对，不能点击发布");
                      }
                      if (!(await matchesContext(execution.context)) || !execution.lease || Date.parse(execution.lease.leaseUntil) <= Date.now()) throw new Error("执行租约失效，不能点击发布");
                      const lease = leaseFrom(await api(`/api/ext/${execution.kind === "publish" ? "publish" : "tasks"}/${execution.id}/heartbeat`, { body: leaseBody(execution) }, execution.context));
                      if (!(await matchesContext(execution.context)) || Date.parse(lease.leaseUntil) <= Date.now()) throw new Error("执行授权或租约失效，不能点击发布");
                      execution.lease = lease; await executionStore.put(execution);
                    } : undefined,
                  );
                  return { ok, diag: diag.join("；") };
                })();
          }),
          sendResponse,
        );
      case "DEEP_COLLECT":
        // 总开关约束同样适用：停用期间不开任何隐藏标签页。
        // 失败不回传错误：深度采集是尽力而为的补充通道；进顺序队列逐篇执行
        return reply(
          getSettings().then(async (s) => {
            if (!s.enabled || (msg.automatic && (!s.autoCollect || !s.deepCollect)))
              return { queued: false };
            const url = new URL(String(msg.url ?? ""));
            if (msg.automatic) url.searchParams.set("__v2m_auto", "1");
            return { queued: await queueDeepCollect(url.href) };
          }),
          sendResponse,
        );
      case "DEEP_COLLECT_CANCEL":
        // 列表页弹窗已采到评论：删掉队列里同笔记的兜底隐藏页任务，
        // 防止残留项被 SW 反复重放成验证码死页
        return reply(
          cancelDeepCollect(String(msg.noteId ?? "")).then((removed) => ({ removed })),
          sendResponse,
        );
      case "SITE_RUN_PUBLISH_JOB":
        return reply(runPublishJobById(Number(msg.jobId)), sendResponse);
      case "SITE_WAKE_COLLECTION_TASKS":
        void dispatchBrowserWork(); sendResponse({ ok: true, data: { queued: true } }); return false;

      // --- popup 采集库 ---
      case "LIST_COLLECTIONS":
        return reply(api("/api/collections"), sendResponse);
      case "CREATE_COLLECTION":
        return reply(
          api("/api/collections", { method: "POST", body: { name: String(msg.name ?? "") } }),
          sendResponse,
        );
    }
    return false;
  },
);

// chrome.debugger 真实点击：dispatchMouseEvent 产生 isTrusted 事件，
// 是 XHS 弹窗 handler 唯一认的触发方式（合成 .click() 会被忽略走默认跳转）
// 传 selectors 时按顺序依次点，全程只 attach 一次：
//  - attach 会弹出「正在调试」提示条把页面往下推，坐标必须 attach 后现场量；
//  - detach 时提示条收起、视口变化，下拉浮层会随之关闭——所以「展开下拉 + 选选项」要在同一次 attach 里做完。
async function trustedClick(
  tabId: number,
  x: number,
  y: number,
  selectors?: string[],
  diag: string[] = [],
  beforePress?: () => Promise<void>,
): Promise<boolean> {
  const target = { tabId };
  const press = async (px: number, py: number) => {
    await beforePress?.();
    // 先 mouseMoved：真实点击都有悬停，部分下拉组件靠它建立 hover 状态
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"] as const) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type,
        x: px,
        y: py,
        button: type === "mouseMoved" ? "none" : "left",
        clickCount: type === "mouseMoved" ? 0 : 1,
      });
    }
  };
  try {
    await chrome.debugger.attach(target, "1.3");
    if (!selectors?.length) {
      await press(x, y);
      return true;
    }
    // 后台标签页不渲染下拉浮层——先切到前台
    await chrome.tabs.update(tabId, { active: true });
    await new Promise((r) => setTimeout(r, 500));
    // 找第一个可见匹配元素，滚到视口中间（底部有吸底发布栏，nearest 会把它滚到栏下面），
    // 并用 elementFromPoint 看该点实际是谁——被浮层盖住时点到的是浮层
    // "选择器 @text=甲|乙"：再按文字精确筛（下拉展开时选项会重新渲染，事先打的标记会落在旧节点上）
    const locate = async (step: string) => {
      // 可选 " @dx=N"：点击点相对元素中心的横向偏移（closed shadow 里的按钮只能按版式算位置）
      const dxm = / @dx=(-?\d+)$/.exec(step);
      const dx = dxm ? Number(dxm[1]) : 0;
      const [sel, textPart] = (dxm ? step.slice(0, dxm.index) : step).split(" @text=");
      const texts = textPart ? textPart.split("|") : null;
      const res = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: `(() => { const texts = ${JSON.stringify(texts)}; for (const e of document.querySelectorAll(${JSON.stringify(sel)})) { if (texts && !texts.includes((e.textContent || "").trim())) continue; let r = e.getBoundingClientRect(); if (r.width <= 0 || r.height <= 0) continue; e.scrollIntoView({ block: "center" }); r = e.getBoundingClientRect(); const x = r.left + r.width / 2 + ${dx}, y = r.top + r.height / 2; const hit = document.elementFromPoint(x, y); const cover = !hit || e === hit || e.contains(hit) ? "" : hit.tagName + "." + String(hit.className).split(" ")[0] + "<" + String(hit.parentElement?.className ?? "").split(" ")[0] + "<" + String(hit.parentElement?.parentElement?.className ?? "").split(" ")[0]; return [x, y, cover]; } return null; })()`,
        returnByValue: true,
      })) as { result?: { value?: [number, number, string] | null } };
      return res.result?.value ?? null;
    };
    const waitVisible = async (sel: string, ms: number) => {
      for (let t = 0; t < ms; t += 200) {
        const pt = await locate(sel);
        if (pt) return pt;
        await new Promise((r) => setTimeout(r, 200));
      }
      return null;
    };
    for (let i = 0; i < selectors.length; i++) {
      let pt = await waitVisible(selectors[i]!, 3000);
      if (!pt) {
        diag.push(`第${i + 1}步元素不可见`);
        return false;
      }
      const next = selectors[i + 1];
      // 点完要等下一步元素出现（如下拉展开）：没出现就 Esc 关掉干扰浮层再点，最多 3 次
      for (let attempt = 1; ; attempt++) {
        if (pt[2]) diag.push(`第${i + 1}步被 ${pt[2]} 遮挡`);
        await press(Math.round(pt[0]), Math.round(pt[1]));
        if (!next || (await waitVisible(next, 1500))) break;
        if (attempt >= 3) {
          // 现场快照：展开的浮层里实际有哪些选项，便于一次对准选择器/文字
          const snap = (await chrome.debugger.sendCommand(target, "Runtime.evaluate", {
            expression: `(() => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }; const dd = [...document.querySelectorAll(".d-dropdown-content,[class*=dropdown],[class*=popover]")].filter(vis).map((e) => String(e.className).split(" ")[0]); const opts = [...document.querySelectorAll(".custom-option,.d-option,[class*=option]")].filter(vis).map((e) => (e.textContent || "").trim().slice(0, 8)); return "可见浮层[" + dd.slice(0, 4).join(",") + "] 可见选项[" + opts.slice(0, 8).join(",") + "]"; })()`,
            returnByValue: true,
          })) as { result?: { value?: string } };
          diag.push(`第${i + 1}步点了 ${attempt} 次，下一步元素仍未出现；${snap.result?.value ?? ""}`);
          return false;
        }
        for (const type of ["keyDown", "keyUp"] as const) {
          await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
            type,
            key: "Escape",
            code: "Escape",
            windowsVirtualKeyCode: 27,
          });
        }
        await new Promise((r) => setTimeout(r, 300));
        pt = (await locate(selectors[i]!)) ?? pt;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return true;
  } catch {
    return false;
  } finally {
    try {
      await chrome.debugger.detach(target);
    } catch {
      /* 已分离 */
    }
  }
}

// ---------- COLLECT_URL：工作台点名采集某篇 ----------

const collectWaiters = new Map<
  string,
  {
    resolve: (r: {
      ok: boolean;
      noteId?: string;
      error?: string;
      detailCaptured?: boolean;
      commentsCaptured?: boolean;
      imageCount?: number;
    }) => void;
    tabId?: number;
    timeoutId?: ReturnType<typeof setTimeout>;
    hardTimeoutId?: ReturnType<typeof setTimeout>;
    challengeTabOpened?: boolean;
    challengeRetryId?: ReturnType<typeof setInterval>;
    collectUrl?: string;
    context?: ExecutionContext;
  }
>();

function clearCollectWaiterTimers(
  waiter: (typeof collectWaiters extends Map<string, infer V> ? V : never),
) {
  if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
  if (waiter.hardTimeoutId) clearTimeout(waiter.hardTimeoutId);
  if (waiter.challengeRetryId) clearInterval(waiter.challengeRetryId);
}

function armCollectWaiterTimeout(
  noteId: string,
  waiter: (typeof collectWaiters extends Map<string, infer V> ? V : never),
) {
  if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
  waiter.timeoutId = setTimeout(() => {
    if (collectWaiters.delete(noteId)) {
      clearCollectWaiterTimers(waiter);
      waiter.resolve({ ok: false, error: "采集超时（页面 120s 内未回执）" });
    }
  }, 120000);
}

type CollectWaiter = typeof collectWaiters extends Map<string, infer V> ? V : never;
let collectContextWrites = Promise.resolve();
function setCollectTabContext(id: number, context?: ExecutionContext) {
  const next = collectContextWrites.then(async () => {
    const contexts = ((await chrome.storage.local.get("collectionTabContexts")).collectionTabContexts ?? {}) as Record<string, ExecutionContext>;
    if (context) contexts[id] = context; else delete contexts[id];
    await chrome.storage.local.set({ collectionTabContexts: contexts });
  });
  collectContextWrites = next.catch(() => {});
  return next;
}
chrome.tabs.onRemoved.addListener(id => { void setCollectTabContext(id).catch(() => {}); });

function isChallengeUrl(url: string) {
  return /\/404\/sec_|\/sec_[a-z]|\/404\?source=/i.test(url);
}

// 采集页触发验证：暂停回执超时；中转页留在后台自行每 12s 跳回原笔记页重试，
// 前台另开笔记正常页给用户验证（不顶那个验证后不回跳的 sec_ 死页）
async function onCollectChallenge(noteId: string, w: CollectWaiter, tabId: number) {
  if (w.timeoutId) {
    clearTimeout(w.timeoutId);
    w.timeoutId = undefined;
  }
  if (!w.challengeRetryId) {
    w.challengeRetryId = setInterval(() => {
      void chrome.tabs
        .get(tabId)
        .then((t) => {
          if (w.collectUrl && isChallengeUrl(t.url ?? "") && w.context) {
            void matchesContext(w.context).then(match => { if (match) return chrome.tabs.update(tabId, { url: w.collectUrl }); }).catch(() => {});
          }
        })
        .catch(() => {});
    }, 12000);
  }
  if (w.challengeTabOpened) return;
  w.challengeTabOpened = true;
  const t = await chrome.tabs.get(tabId).catch(() => undefined);
  if (noteId && isChallengeUrl(t?.url ?? "")) {
    void chrome.tabs
      .create({ url: `https://www.xiaohongshu.com/explore/${noteId}`, active: true })
      .catch(() => {});
  } else {
    void chrome.tabs.update(tabId, { active: true }).catch(() => {});
  }
}

function onCollectChallengeCleared(noteId: string, w: CollectWaiter) {
  w.challengeTabOpened = false;
  if (w.challengeRetryId) {
    clearInterval(w.challengeRetryId);
    w.challengeRetryId = undefined;
  }
  armCollectWaiterTimeout(noteId, w);
}

async function collectByUrl(url: string) {
  const context = await authContext();
  const owner = `collect:${url.match(/[0-9a-f]{24}/i)?.[0] ?? "manual"}`;
  if (!(await reserveBrowser(owner))) throw new BrowserBusyError();
  try { return await performCollectByUrl(url, context); } finally { browserLane.release(owner); }
}
async function performCollectByUrl(url: string, context: ExecutionContext) {
  if (!(await matchesContext(context))) throw new NotAuthorizedError();
  if (!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(url)) {
    throw new Error("仅支持 xiaohongshu.com 链接");
  }
  const noteId = url.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i)?.[1] ?? "";
  const marker = `__v2m_collect=1`;
  const target = url + (url.includes("?") ? "&" : "?") + marker;
  const waiter: CollectWaiter = { resolve: () => {}, collectUrl: target, context };
  const done = new Promise<Parameters<typeof waiter.resolve>[0]>((resolve) => {
    waiter.resolve = resolve;
    collectWaiters.set(noteId, waiter);
    armCollectWaiterTimeout(noteId, waiter);
    waiter.hardTimeoutId = setTimeout(() => {
      if (collectWaiters.delete(noteId)) {
        clearCollectWaiterTimers(waiter);
        resolve({ ok: false, error: "验证码等待超过 15 分钟，任务已取消" });
      }
    }, 15 * 60 * 1000);
  });
  // SW 重启后队列头会重放同一 noteId：先收掉旧生命周期残留的采集页，避免同一笔记堆多个隐藏页
  if (noteId) {
    const stale = await chrome.tabs.query({ url: "*://*.xiaohongshu.com/*" });
    for (const t of stale) {
      if (
        t.id &&
        t.url?.includes("__v2m_collect") &&
        t.url.includes(noteId)
      ) {
        await chrome.tabs.remove(t.id).catch(() => {});
      }
    }
  }
  const tab = await chrome.tabs.create({ url: target, active: false });
  waiter.tabId = tab.id; // 绑定 tab：回执只能由它完成（重启后旧页回执不顶包）
  if (tab.id) {
    await setCollectTabContext(tab.id, context);
  }
  const r = await done;
  if (!r.ok) {
    if (tab.id && r.error?.includes("验证码")) {
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
    } else if (tab.id) {
      await chrome.tabs.remove(tab.id).catch(() => {});
    }
    throw new Error(r.error ?? "采集失败");
  }
  if (tab.id) await chrome.tabs.remove(tab.id).catch(() => {});
  return {
    collected: true,
    noteId: r.noteId,
    detailCaptured: r.detailCaptured,
    commentsCaptured: r.commentsCaptured,
    imageCount: r.imageCount,
  };
}

// ---------- DEEP_COLLECT 顺序队列：一次只开一个隐藏页，避免批量并发开 tab ----------
// 队列持久化在 storage.session：SW 挂起/重启后可恢复续跑；重启浏览器则丢弃（可接受）

const DEEP_Q_KEY = "deepQueue";
let deepQueue: string[] = [];
const deepQueuedIds = new Set<string>();
const deepAttempts = new Map<string, number>();
let deepPumping = false;
let deepQueueLoaded = false;
let deepQueueLoading: Promise<void> | null = null;
let deepQueueContext: ExecutionContext | null = null;

// persist 串行化：多次连续写不同步会乱序，旧快照可能盖掉新入队项
let persistTail = Promise.resolve();
function persistDeepQueue() {
  persistTail = persistTail
    .then(() => chrome.storage.session.set({ [DEEP_Q_KEY]: deepQueue, deepQueueContext }))
    .catch(() => {});
  return persistTail;
}

async function loadDeepQueue() {
  if (deepQueueLoading) return deepQueueLoading;
  if (deepQueueLoaded) return;
  deepQueueLoading = loadStoredDeepQueue();
  try { await deepQueueLoading; deepQueueLoaded = true; } finally { deepQueueLoading = null; }
}
async function loadStoredDeepQueue() {
  const snapshot = await chrome.storage.session.get([DEEP_Q_KEY, "deepQueueContext"]);
  const stored = snapshot[DEEP_Q_KEY]; deepQueueContext = snapshot.deepQueueContext ?? deepQueueContext;
  if (Array.isArray(stored)) {
    // 合并不覆盖：本生命周期已入队（还没持久化）的项不能被清掉
    for (const u of stored) {
      if (typeof u !== "string") continue;
      const id = u.match(/([0-9a-f]{24})/)?.[1] ?? u;
      if (!deepQueuedIds.has(id) && !deepQueue.includes(u)) {
        deepQueuedIds.add(id);
        deepQueue.push(u); // 保持存储顺序：先恢复上次没跑完的，新入队排后
      }
    }
  }
}

async function cancelDeepCollect(noteId: string): Promise<number> {
  if (!noteId) return 0;
  await loadDeepQueue();
  const before = deepQueue.length;
  deepQueue = deepQueue.filter((u) => {
    const id = u.match(/([0-9a-f]{24})/)?.[1] ?? u;
    return id !== noteId;
  });
  deepQueuedIds.delete(noteId);
  deepAttempts.delete(noteId);
  if (deepQueue.length !== before) await persistDeepQueue();
  return before - deepQueue.length;
}

async function queueDeepCollect(url: string): Promise<boolean> {
  await loadDeepQueue();
  const context = await authContext();
  if (deepQueue.length && (!deepQueueContext || deepQueueContext.epoch !== context.epoch || deepQueueContext.apiBase !== context.apiBase)) throw new Error("深采队列属于之前的授权，请先取消原队列");
  deepQueueContext = context;
  const id = url.match(/([0-9a-f]{24})/)?.[1] ?? url;
  if (deepQueuedIds.has(id) || deepQueue.length >= 30) return false;
  deepQueuedIds.add(id);
  deepQueue.push(url);
  void persistDeepQueue();
  void pumpDeepQueue();
  return true;
}

async function pumpDeepQueue() {
  if (deepPumping) return;
  deepPumping = true;
  try {
    await loadDeepQueue(); // 恢复上次 SW 生命周期里没跑完的队列
    while (deepQueue.length) {
      if (!deepQueueContext || !(await matchesContext(deepQueueContext))) { recoveryBlocked = "深采队列属于之前的授权，等待核对"; break; }
      if (!(await getAuth()) || browserLane.busy || !(await collectionSafetyReady()) || await highPriorityWaiting()) break;
      // 停用中断：中途关总开关 → 清空剩余队列，不再开页
      if (!(await getSettings()).enabled) {
        deepQueue = [];
        deepQueuedIds.clear();
        await persistDeepQueue();
        break;
      }
      const url = deepQueue[0]!;
      const id = url.match(/([0-9a-f]{24})/)?.[1] ?? url;
      const settings = await getSettings();
      if (new URL(url).searchParams.has("__v2m_auto") &&
          (!settings.autoCollect || !settings.deepCollect)) {
        deepQueue = deepQueue.filter(u => (u.match(/([0-9a-f]{24})/)?.[1] ?? u) !== id);
        deepQueuedIds.delete(id);
        await persistDeepQueue();
        continue;
      }
      try {
        await collectByUrl(url);
        deepAttempts.delete(id);
        const storedFailure = (await chrome.storage.local.get("lastDeepCollectFailure"))
          .lastDeepCollectFailure as { noteId?: string } | undefined;
        if (storedFailure?.noteId === id) {
          await chrome.storage.local.remove("lastDeepCollectFailure");
        }
      } catch (error) {
        if (error instanceof BrowserBusyError) break;
        const attempts = (deepAttempts.get(id) ?? 0) + 1;
        const message = String((error as Error)?.message ?? error);
        const challenge = message.includes("验证码");
        deepAttempts.set(id, challenge ? 2 : attempts);
        await chrome.storage.local.set({
          lastDeepCollectFailure: { noteId: id, error: message, at: Date.now() },
        });
        if (!challenge && attempts < 2) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
          continue;
        }
        deepAttempts.delete(id);
      }
      // 先跑完再出队：处理中若 SW 重启，该 URL 仍在队列里会被重试（幂等）
      deepQueue = deepQueue.filter(u => (u.match(/([0-9a-f]{24})/)?.[1] ?? u) !== id);
      deepQueuedIds.delete(id);
      await persistDeepQueue();
    }
  } finally {
    deepPumping = false;
  }
}

// Startup reconciles durable executions before any queue can reserve the browser.

// ---------- 图片下载（creator-publish 用，绕 CORS） ----------

async function fetchImageAsDataUrl(url: string): Promise<{ dataUrl: string }> {
  if (!/^https?:\/\//.test(url)) throw new Error("图片 URL 非法");
  const res = await fetch(url, { credentials: "omit" });
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const mime = res.headers.get("content-type") ?? "image/jpeg";
  return { dataUrl: `data:${mime};base64,${btoa(bin)}` };
}

// ---------- tabs.onUpdated：发布页加载完 -> 推 payload ----------

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // 归因任务页被重定向到登录页 → 标记 loginSuspected（等 deadline 时按 login_required 归档）
  const redirectUrl = info.url ?? tab.url ?? "";
  if (/login|passport/i.test(redirectUrl)) {
    for (const t of trackedTasks.values()) {
      if (t.tabId === tabId) t.loginSuspected = true;
    }
  }
  // 采集页被服务端 302 到验证中转页时内容脚本不会加载，只能靠 URL 变化识别
  for (const [noteId, w] of collectWaiters) {
    if (w.tabId !== tabId) continue;
    if (isChallengeUrl(redirectUrl)) {
      void onCollectChallenge(noteId, w, tabId);
    } else if (
      redirectUrl &&
      info.status === "complete" &&
      (w.challengeRetryId || w.challengeTabOpened)
    ) {
      onCollectChallengeCleared(noteId, w);
    }
  }
  // JOB_READY is the single durable handoff. Reloading a delivered page must not replay platform actions.
});

// ---------- alarms ----------

const HEARTBEAT_ALARM = "v2m-heartbeat";
const PUBLISH_ALARM = "v2m-publish-poll";
const HEARTBEAT_MIN = 5;
const PUBLISH_MIN = 1;

async function highPriorityWaiting() {
  if (!(await getAuth())) return false;
  const pending = await fetchPendingJobs();
  if (pending.some(j => j.status === "pending")) return true;
  const tasks = (await api<PendingTasksResponse>("/api/ext/tasks/pending?limit=5")).tasks ?? [];
  const current = await currentXhsUserId();
  return tasks.some(t => !needsAccountMatch(t.type) || !(t.payload as Record<string, unknown>).xhsUserId || (t.payload as Record<string, unknown>).xhsUserId === current);
}
let keywordExecution: BrowserExecution | null = null;
const keywordRunner = new KeywordRunner({
  api: async <T>(path: string, body?: unknown): Promise<T> => {
    if (!keywordContext) keywordContext = await authContext();
    if (path.endsWith("/finish") && keywordExecution) {
      const receipt = await executionStore.enqueue({ key: `keyword:${keywordExecution.id}:${(body as { leaseId: string }).leaseId}`,
        kind: "keyword", id: keywordExecution.id, context: keywordContext, path, body: body as Record<string, unknown> });
      await transmitReceipt(receipt); return {} as T;
    }
    const result = await api<T>(path, { body }, keywordContext);
    if (path.endsWith("/claim")) {
      const claim = (result as { claim?: CollectionTaskClaim }).claim;
      if (claim) {
        keywordExecution = { kind: "keyword", id: claim.task.id, context: keywordContext, deadline: Date.now() + 30 * 60_000,
          payload: { leaseId: claim.leaseId, revision: claim.task.revision }, phase: "running" };
        await executionStore.put(keywordExecution);
      }
    }
    return result;
  }, ownerId: swId, enabled: async () => (await getSettings()).enabled && !!(await getAuth()) && (!keywordContext || await matchesContext(keywordContext)),
  reserve: reserveBrowser, release: async owner => { browserLane.release(owner); keywordContext = null; keywordExecution = null; }, priorityWaiting: highPriorityWaiting,
  open: async url => {
    if (!keywordContext || !(await matchesContext(keywordContext))) throw new NotAuthorizedError();
    const tab = await chrome.tabs.create({ url, active: false }); if (!tab.id) throw new Error("无法创建任务页");
    if (keywordExecution) { keywordExecution.tabId = tab.id; await executionStore.put(keywordExecution); }
    return tab.id;
  },
  close: async id => { await chrome.tabs.remove(id).catch(() => {}); }, focus: async id => { await chrome.tabs.update(id, { active: true }); },
  page: async (id, leaseId, action, noteId) => {
    if (!keywordContext || !(await matchesContext(keywordContext))) throw new NotAuthorizedError();
    const response = await chrome.tabs.sendMessage(id, { type: "COLLECTION_PAGE", leaseId, action, noteId }) as BgResponse<CollectionPageSnapshot>;
    if (!response?.ok || !response.data) throw new Error(response?.error ?? "任务页尚未就绪"); return response.data;
  }, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)), now: Date.now,
  block: async (taskId, leaseId, revision, tabId, reason) => {
    if (!keywordContext) throw new NotAuthorizedError();
    await chrome.storage.local.set({ collectionSafetyBlock: { taskId, leaseId, revision, tabId, reason, context: keywordContext,
      pendingFinish: { leaseId, revision, outcome: "blocked", reason } } satisfies CollectionSafetyBlock });
  },
});
let dispatching = false;
async function dispatchBrowserWork() {
  if (dispatching) return; dispatching = true;
  try { await reconcileBrowserExecutions(); await collectionSafetyReady();
    if (recoveryBlocked) return;
    await pollPendingJobs(); await pollTasks(); if (browserLane.busy) return;
    await pumpDeepQueue(); if (!browserLane.busy && !deepQueue.length) { await keywordRunner.run(); if (await highPriorityWaiting()) { await pollPendingJobs(); await pollTasks(); } }
  } catch (e) { console.warn("[v2m] automation dispatch failed", e); } finally { dispatching = false; }
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) void heartbeat();
  if (alarm.name === PUBLISH_ALARM) {
    void dispatchBrowserWork();
  }
});

// 只补缺失的 alarm：同名 create 会把计时清零重排。SW 每次被唤醒都会重跑顶层代码，
// 若无条件 create，唤醒它的那次 alarm 被替换掉，之后周期永远到不了——刷新插件后
// 不开工作台页面（PING 保活）时心跳和领任务就全停了。
async function ensureAlarms() {
  for (const [name, periodInMinutes] of [
    [HEARTBEAT_ALARM, HEARTBEAT_MIN],
    [PUBLISH_ALARM, PUBLISH_MIN],
  ] as const) {
    if (!(await chrome.alarms.get(name))) await chrome.alarms.create(name, { periodInMinutes });
  }
}

/** 安装/刷新/浏览器启动后立刻上报一次，不等第一个 alarm 周期。 */
function kick() {
  void ensureAlarms();
  void heartbeat();
  void dispatchBrowserWork();
}

chrome.runtime.onInstalled.addListener(kick);
chrome.runtime.onStartup.addListener(kick);
void ensureAlarms(); // SW 冷启动兜底
