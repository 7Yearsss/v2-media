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
  PendingPublishJobsResponse,
} from "@v2media/shared";
import type { BgMessage, BgResponse, LoginState, PublishJobPayload } from "./lib/messages";

const VERSION = chrome.runtime.getManifest().version;
const SW_ID = `${VERSION}-${Math.random().toString(36).slice(2, 8)}`; // 认领标识（防多实例重复 claim）

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

async function fetchPendingJobs(): Promise<PublishJobPayload[]> {
  const res = await api<PendingPublishJobsResponse>("/api/ext/publish/pending");
  return res.jobs ?? [];
}

async function claimAndOpen(job: PublishJobPayload) {
  if (trackedJobs.has(job.id)) return;
  await api(`/api/ext/publish/${job.id}/claim`, { body: { claimedBy: SW_ID } });
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
}

async function pollPendingJobs() {
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
  // 超时兜底：内容脚本一直没回传 -> failed
  for (const [id, t] of trackedJobs) {
    if ((t.state === "opening" || t.state === "running") && Date.now() > t.deadline) {
      trackedJobs.delete(id);
      await api(`/api/ext/publish/${id}/result`, {
        body: { status: "failed", error: "插件执行超时（发布页未回传结果）" },
      }).catch(() => {});
      if (t.tabId) chrome.tabs.remove(t.tabId).catch(() => {});
    }
  }
}

async function payloadForJob(jobId: number): Promise<PublishJobPayload> {
  // 已认领的任务优先用内存里的 payload（pending 列表不再返回它）。
  const tracked = trackedJobs.get(jobId);
  if (tracked) return tracked.payload;
  // 未认领（手动打开 ?job_id=N 或 SW 重启丢了状态）：从 pending 找并认领。
  // TODO(契约): pending 列表是唯一能拿到草稿全文的接口；已 claim 任务被过滤，
  // SW 重启后 trackedJobs 丢失即拿不到 payload —— 契约需补 GET /api/ext/publish/:id
  //（或 claim 响应直接回草稿）。
  const jobs = await fetchPendingJobs();
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw new Error(`服务端没有 job ${jobId} 的待发布任务`);
  await api(`/api/ext/publish/${job.id}/claim`, { body: { claimedBy: SW_ID } });
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
  const job = (await fetchPendingJobs()).find((j) => j.id === jobId);
  if (!job) throw new Error(`任务 ${jobId} 不在待发布列表（可能已被认领/执行）`);
  await claimAndOpen(job);
  return { opened: true, jobId };
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
          api<CollectResponse>("/api/ext/collect", { body: msg.batch }).then(async (r) => {
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
            const { stats } = (await chrome.storage.local.get("stats")) as {
              stats?: { collected?: number };
            };
            return {
              version: VERSION,
              authorized: !!auth,
              appUrl: auth?.apiBase ?? defaultAppOrigin(),
              collected: stats?.collected ?? 0,
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

      // --- COLLECT_URL 回执 ---
      case "COLLECT_URL_DONE": {
        const resolve = collectWaiters.get(msg.noteId ?? "");
        if (resolve) {
          collectWaiters.delete(msg.noteId ?? "");
          resolve({ ok: msg.ok, noteId: msg.noteId, error: msg.error });
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
      case "SITE_RUN_PUBLISH_JOB":
        return reply(runPublishJobById(Number(msg.jobId)), sendResponse);
    }
    return false;
  },
);

// ---------- COLLECT_URL：工作台点名采集某篇 ----------

const collectWaiters = new Map<
  string,
  (r: { ok: boolean; noteId?: string; error?: string }) => void
>();

async function collectByUrl(url: string) {
  if (!/^https:\/\/(www\.)?xiaohongshu\.com\//.test(url)) {
    throw new Error("仅支持 xiaohongshu.com 链接");
  }
  const noteId = url.match(/\/(?:explore|search_result|discovery\/item)\/([0-9a-f]{24})/i)?.[1] ?? "";
  const marker = `__v2m_collect=1`;
  const target = url + (url.includes("?") ? "&" : "?") + marker;
  const done = new Promise<{ ok: boolean; noteId?: string; error?: string }>((resolve) => {
    collectWaiters.set(noteId, resolve);
    setTimeout(() => {
      if (collectWaiters.delete(noteId)) {
        resolve({ ok: false, error: "采集超时（页面 20s 内未回执）" });
      }
    }, 25000);
  });
  await chrome.tabs.create({ url: target, active: false });
  const r = await done;
  if (!r.ok) throw new Error(r.error ?? "采集失败");
  return { collected: true, noteId: r.noteId };
}

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

chrome.tabs.onUpdated.addListener((tabId, info) => {
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
  if (alarm.name === PUBLISH_ALARM) void pollPendingJobs();
});

function ensureAlarms() {
  void chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: HEARTBEAT_MIN });
  void chrome.alarms.create(PUBLISH_ALARM, { periodInMinutes: PUBLISH_MIN });
}

chrome.runtime.onInstalled.addListener(ensureAlarms);
chrome.runtime.onStartup.addListener(ensureAlarms);
ensureAlarms(); // SW 冷启动兜底（alarms 持久存在，重复 create 是幂等重置）
