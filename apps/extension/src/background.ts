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
  ExtTask,
  PendingPublishJobsResponse,
  PendingTasksResponse,
  PublishOutcome,
} from "@v2media/shared";
import {
  isAuthError,
  metricsRowsFromResponse,
  personalInfoFromResponse,
  postedNotesFromResponse,
} from "@v2media/shared";
import type {
  BgMessage,
  BgResponse,
  GalaxyEventDetail,
  LoginState,
  PublishJobPayload,
} from "./lib/messages";
import { getSettings, setSettings } from "./lib/settings";

const VERSION = chrome.runtime.getManifest().version;

/**
 * 认领标识：storage.session 持久 → SW 重启后同一浏览器仍是同一认领方
 * （GET /publish/:id?claimer= 校验用）；换浏览器则 id 不同，防止重复执行 running 任务。
 */
async function swId(): Promise<string> {
  const { swId } = (await chrome.storage.session.get("swId")) as { swId?: string };
  if (swId) return swId;
  const id = `${VERSION}-${Math.random().toString(36).slice(2, 8)}`;
  await chrome.storage.session.set({ swId: id });
  return id;
}

interface ExtAuth {
  apiBase: string;
  token: string;
}

interface TrackedJob {
  jobId: number;
  tabId?: number;
  state: "opening" | "running" | "done" | "failed";
  openedAt: number;
  deadline: number;
  payload: PublishJobPayload;
}

async function getAuth(): Promise<ExtAuth | null> {
  const { auth } = await chrome.storage.local.get("auth");
  return (auth as ExtAuth | undefined) ?? null;
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

async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const auth = await getAuth();
  if (!auth) throw new NotAuthorizedError();
  const res = await fetch(`${auth.apiBase}${path}`, {
    method: init.method ?? (init.body !== undefined ? "POST" : "GET"),
    headers: {
      ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: `Bearer ${auth.token}`,
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 401) {
    await chrome.storage.local.remove("auth");
    throw new NotAuthorizedError("插件授权已失效，请在工作台重新「授权插件」");
  }
  if (!res.ok) throw new Error((data?.error as string) ?? `服务端错误 HTTP ${res.status}`);
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
async function currentXhsUserId(): Promise<string> {
  if (_curAccountCache && Date.now() - _curAccountCache.at < 60_000) {
    return _curAccountCache.id;
  }
  const id = await resolveXhsUserId();
  _curAccountCache = { id, at: Date.now() };
  return id;
}

async function resolveXhsUserId(): Promise<string> {
  const tab = await accountFromOpenTab();
  if (tab?.xhsUserId) return tab.xhsUserId;
  try {
    const res = await fetch("https://www.xiaohongshu.com/", { credentials: "include" });
    if (res.ok) {
      const html = await res.text();
      const m = html.match(/"user(?:I|_i)nfo"\s*:\s*\{[^}]*?"(?:userId|user_id|red_id)"\s*:\s*"([^"]+)"/i);
      if (m?.[1]) return m[1];
    }
  } catch {
    // 抓不到就落到 lastAccount
  }
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

async function claimAndOpen(job: PublishJobPayload): Promise<boolean> {
  if (trackedJobs.has(job.id)) return true;
  const mismatch = await accountMismatch(job);
  if (mismatch) {
    console.warn(`[v2m] job ${job.id} skipped: ${mismatch}`);
    return false;
  }
  await api(`/api/ext/publish/${job.id}/claim`, { body: { claimedBy: await swId() } });
  const tracked: TrackedJob = {
    jobId: job.id,
    state: "opening",
    openedAt: Date.now(),
    deadline: Date.now() + JOB_TIMEOUT_MS,
    payload: job,
  };
  trackedJobs.set(job.id, tracked);
  const tab = await chrome.tabs.create({
    url: `https://creator.xiaohongshu.com/publish/publish?job_id=${job.id}`,
    active: false,
  });
  tracked.tabId = tab.id;
  return true;
}

async function pollPendingJobs() {
  // 超时兜底先做：停用期间也要回收卡死的已认领任务，不随总开关停
  for (const [id, t] of trackedJobs) {
    if ((t.state === "opening" || t.state === "running") && Date.now() > t.deadline) {
      trackedJobs.delete(id);
      await api(`/api/ext/publish/${id}/result`, {
        body: { status: "failed", error: "插件执行超时（发布页未回传结果）" },
      }).catch(() => {});
      if (t.tabId) chrome.tabs.remove(t.tabId).catch(() => {});
    }
  }
  if (!(await getSettings()).enabled) return; // 总开关关闭：不领发布任务
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
      await claimAndOpen(job);
    } catch (e) {
      console.warn(`[v2m] claim job ${job.id} failed:`, e);
    }
  }
}

async function payloadForJob(jobId: number): Promise<PublishJobPayload> {
  // 总开关关：JOB_READY / 手动打开发布页 / tabs.onUpdated 推 payload 都从这里进，先拦住
  if (!(await getSettings()).enabled) throw new Error("插件已停用");
  // 已认领的任务优先用内存里的 payload（pending 列表不再返回它）。
  const tracked = trackedJobs.get(jobId);
  if (tracked) return tracked.payload;
  // 未认领（手动打开 ?job_id=N 或 SW 重启丢了状态）：单条接口能恢复 pending/running 任务
  const job = await api<PublishJobPayload>(
    `/api/ext/publish/${jobId}?claimer=${encodeURIComponent(await swId())}`,
  ).catch(async () => (await fetchPendingJobs()).find((j) => j.id === jobId));
  if (!job) throw new Error(`服务端没有 job ${jobId} 的待发布任务`);
  // Run Now 标记持久在 storage.session：SW 重启后恢复 payload 时重新覆盖掉原定时
  const runNowKey = `runNow:${job.id}`;
  if ((await chrome.storage.session.get(runNowKey))[runNowKey]) {
    job.scheduledAt = undefined;
  }
  if (job.status === "pending") {
    await api(`/api/ext/publish/${job.id}/claim`, { body: { claimedBy: await swId() } });
  }
  trackedJobs.set(job.id, {
    jobId: job.id,
    state: "running",
    openedAt: Date.now(),
    deadline: Date.now() + JOB_TIMEOUT_MS,
    payload: job,
  });
  return job;
}

async function runPublishJobById(jobId: number) {
  // 工作台 Run Now 也是任务入口，跟轮询一样受总开关约束
  if (!(await getSettings()).enabled) throw new Error("插件已停用");
  const job =
    (await fetchPendingJobs(true).then((js) => js.find((j) => j.id === jobId))) ??
    (await api<PublishJobPayload>(
      `/api/ext/publish/${jobId}?claimer=${encodeURIComponent(await swId())}`,
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
  trackedTasks.delete(t.taskId);
  if (t.tabId) void chrome.tabs.remove(t.tabId).catch(() => {});
  await api(`/api/ext/tasks/${t.taskId}/result`, { body }).catch((e) => {
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
    let claimed = false;
    try {
      await api(`/api/ext/tasks/${task.id}/claim`, { body: { claimedBy: await swId() } });
      claimed = true;
    } catch {
      continue;
    }
    if (!claimed) continue;
    const url = taskTabUrl(task);
    if (!url) {
      await api(`/api/ext/tasks/${task.id}/result`, {
        body: { status: "failed", error: `未知任务类型 ${task.type}` },
      }).catch(() => {});
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
    };
    trackedTasks.set(task.id, tracked);
    lastTaskOpenAt = now;
    try {
      const tab = await chrome.tabs.create({ url, active: false });
      tracked.tabId = tab.id;
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
            .then((s) => {
              // 停用中拒绝入库：报错而非假成功，content 侧会把未成功的批次塞回 pending
              if (!s.enabled) throw new Error("插件已停用");
              return api<CollectResponse>("/api/ext/collect", { body: msg.batch }).catch(
                async (e) => {
                  // 所选库已被工作台删除：自愈回「不分组」并重试（批次不能丢）
                  if (!/collection not found/.test(String((e as Error)?.message ?? e))) throw e;
                  await setSettings({ collectionId: null });
                  const { collectionId: _drop, ...rest } = msg.batch;
                  return api<CollectResponse>("/api/ext/collect", {
                    body: { ...rest, collectionId: null },
                  });
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
            };
          }),
          sendResponse,
        );

      // --- 发布链路 ---
      case "JOB_READY":
        return reply(
          payloadForJob(Number(msg.jobId)).then((payload) => {
            const t = trackedJobs.get(payload.id);
            if (t) t.state = "running";
            return { payload };
          }),
          sendResponse,
        );

      case "JOB_RESULT": {
        trackedJobs.delete(msg.jobId);
        return reply(
          api(`/api/ext/publish/${msg.jobId}/result`, {
            body: { status: msg.status, resultUrl: msg.resultUrl, error: msg.error },
          }).then(() => ({ reported: true })),
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
        if (t && !t.done && t.type === "metrics" && msg.data) {
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
          setTimeout(() => chrome.tabs.remove(sid).catch(() => {}), 1000);
        }
        sendResponse({ ok: true });
        return false;
      }
      case "COLLECT_URL_CHALLENGE": {
        const w = collectWaiters.get(msg.noteId ?? "");
        const sid = sender.tab?.id;
        if (w && sid && (w.tabId === undefined || w.tabId === sid)) {
          if (w.timeoutId) {
            clearTimeout(w.timeoutId);
            w.timeoutId = undefined;
          }
          void chrome.tabs.update(sid, { active: true });
        }
        sendResponse({ ok: true });
        return false;
      }
      case "COLLECT_URL_CHALLENGE_DONE": {
        const noteId = msg.noteId ?? "";
        const w = collectWaiters.get(noteId);
        const sid = sender.tab?.id;
        if (w && sid && (w.tabId === undefined || w.tabId === sid)) {
          armCollectWaiterTimeout(noteId, w);
        }
        sendResponse({ ok: true });
        return false;
      }

      // --- site-bridge（工作台 origin 限定） ---
      case "SITE_PING":
        return reply(
          getAuth().then((auth) => ({ version: VERSION, authorized: !!auth })),
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
          chrome.storage.local.set({ auth: { apiBase, token } satisfies ExtAuth }).then(async () => {
            void heartbeat();
            void pollPendingJobs();
            return { ok: true };
          }),
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
      case "DEEP_COLLECT":
        // 总开关约束同样适用：停用期间不开任何隐藏标签页。
        // 失败不回传错误：深度采集是尽力而为的补充通道；进顺序队列逐篇执行
        return reply(
          getSettings().then((s) => ({
            queued: s.enabled ? queueDeepCollect(String(msg.url ?? "")) : false,
          })),
          sendResponse,
        );
      case "SITE_RUN_PUBLISH_JOB":
        return reply(runPublishJobById(Number(msg.jobId)), sendResponse);

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
  }
>();

function clearCollectWaiterTimers(
  waiter: (typeof collectWaiters extends Map<string, infer V> ? V : never),
) {
  if (waiter.timeoutId) clearTimeout(waiter.timeoutId);
  if (waiter.hardTimeoutId) clearTimeout(waiter.hardTimeoutId);
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

async function collectByUrl(url: string) {
  if (!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(url)) {
    throw new Error("仅支持 xiaohongshu.com 链接");
  }
  const noteId = url.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i)?.[1] ?? "";
  const marker = `__v2m_collect=1`;
  const target = url + (url.includes("?") ? "&" : "?") + marker;
  const waiter: (typeof collectWaiters extends Map<string, infer V> ? V : never) =
    { resolve: () => {} };
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
  const tab = await chrome.tabs.create({ url: target, active: false });
  waiter.tabId = tab.id; // 绑定 tab：回执只能由它完成（重启后旧页回执不顶包）
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

// persist 串行化：多次连续写不同步会乱序，旧快照可能盖掉新入队项
let persistTail = Promise.resolve();
function persistDeepQueue() {
  persistTail = persistTail
    .then(() => chrome.storage.session.set({ [DEEP_Q_KEY]: deepQueue }))
    .catch(() => {});
  return persistTail;
}

async function loadDeepQueue() {
  if (deepQueueLoaded) return;
  deepQueueLoaded = true;
  const stored = (await chrome.storage.session.get(DEEP_Q_KEY))[DEEP_Q_KEY];
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

function queueDeepCollect(url: string): boolean {
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
      // 停用中断：中途关总开关 → 清空剩余队列，不再开页
      if (!(await getSettings()).enabled) {
        deepQueue = [];
        deepQueuedIds.clear();
        await persistDeepQueue();
        break;
      }
      const url = deepQueue[0]!;
      const id = url.match(/([0-9a-f]{24})/)?.[1] ?? url;
      try {
        await collectByUrl(url);
        deepAttempts.delete(id);
        await chrome.storage.local.remove("lastDeepCollectFailure");
      } catch (error) {
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
      deepQueue.shift();
      deepQueuedIds.delete(id);
      await persistDeepQueue();
    }
  } finally {
    deepPumping = false;
  }
}

// SW 启动即恢复队列（storage.session 在 SW 挂起/重启间存活）
void pumpDeepQueue();

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
  if (info.status !== "complete") return;
  for (const [jobId, t] of trackedJobs) {
    if (t.tabId !== tabId || t.state !== "opening") continue;
    // content script document_idle 注入，complete 时一定已就位
    void (async () => {
      try {
        const payload = await payloadForJob(jobId);
        await chrome.tabs.sendMessage(tabId, { type: "JOB_PAYLOAD", payload });
        t.state = "running";
      } catch (e) {
        // 页面可能还在等 JOB_READY 主动拉取，不视为失败
        console.warn(`[v2m] push payload to tab ${tabId} failed:`, e);
      }
    })();
  }
});

// ---------- alarms ----------

const HEARTBEAT_ALARM = "v2m-heartbeat";
const PUBLISH_ALARM = "v2m-publish-poll";
const HEARTBEAT_MIN = 5;
const PUBLISH_MIN = 1;

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_ALARM) void heartbeat();
  if (alarm.name === PUBLISH_ALARM) {
    void pollPendingJobs();
    void pollTasks();
  }
});

function ensureAlarms() {
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MIN });
  void chrome.alarms.create(PUBLISH_ALARM, { periodInMinutes: PUBLISH_MIN });
}

chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(ensureAlarms);
ensureAlarms(); // SW 冷启动兜底（alarms 持久存在，重复 create 是幂等重置）
