import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { webcrypto } from "node:crypto";
import vm from "node:vm";
import { build } from "esbuild";

/** This fixture bundles the actual MV3 worker. No real Chrome, .env or network is used. */
export async function bundleBackground(): Promise<string> {
  const file = resolve(import.meta.dirname, "../../../extension/src/background.ts");
  const contents = await readFile(file, "utf8");
  const result = await build({
    stdin: { contents, sourcefile: file, resolveDir: resolve(file, ".."), loader: "ts" },
    bundle: true, format: "iife", platform: "browser", target: "chrome120", write: false,
  });
  return result.outputFiles[0]!.text;
}

type Listener = (...args: any[]) => any;
function event() {
  const listeners: Listener[] = [];
  return { listeners, addListener: (listener: Listener) => listeners.push(listener),
    removeListener: (listener: Listener) => { const i = listeners.indexOf(listener); if (i >= 0) listeners.splice(i, 1); },
    emit: (...args: any[]) => listeners.forEach(listener => listener(...args)) };
}
export function fixtureStorage(seed: Record<string, any> = {}) {
  const data = structuredClone(seed);
  return { data,
    async get(keys?: string | string[] | Record<string, any> | null) {
      if (typeof keys === "string") return { [keys]: structuredClone(data[keys]) };
      if (Array.isArray(keys)) return Object.fromEntries(keys.map(key => [key, structuredClone(data[key])]));
      return structuredClone(data);
    },
    async set(value: Record<string, any>) { Object.assign(data, structuredClone(value)); },
    async remove(keys: string | string[]) { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
  };
}

export const fixtureAccount = "000000000000000000000002";
export const fixtureNote = "000000000000000000000013";
export const fixtureBase = "https://offline.invalid";
export const fixtureEpoch = "fixture-auth-epoch";
const lease = (attempt = 1) => ({ claimedBy: "fixture-sw", leaseId: `00000000-0000-4000-8000-${String(attempt).padStart(12, "0")}`,
  attempt, leaseUntil: "2026-10-02T08:10:00.000Z" });
export const publishFixture = (id = 101, status = "pending") => ({ id, status, xhsUserId: fixtureAccount,
  draft: { title: "Offline publication", content: "Only a fixture", images: [] }, ...(status === "running" ? lease() : {}) });
export const taskFixture = (id = 86, status = "queued") => ({ id, type: "metrics", status,
  payload: { noteId: fixtureNote, noteUrl: `https://www.xiaohongshu.com/explore/${fixtureNote}` },
  ...(status === "processing" ? lease() : {}) });
export const keywordFixture = (id = 5, revision = 1, status = "running") => ({
  id, revision, status, controlRevision: 0, lastControlAction: null, keyword: "Offline keyword", phase: "search", scrollSteps: 0, intervalMs: 2000,
  scanLimit: 10, saveLimit: 1, commentLimit: 0, counts: { saved: 0, partial: 0 },
});

type Tab = { id: number; url?: string; active?: boolean; status?: string };
export type ApiCall = { url: string; path: string; method: string; body?: any; authorization?: string };
type HarnessOptions = {
  tabs?: Tab[]; jobs?: any[]; tasks?: any[];
  keywordClaim?: any; keywordStates?: Record<number, any>;
  local?: ReturnType<typeof fixtureStorage>; session?: ReturnType<typeof fixtureStorage>;
  /** In-memory Hono seam, used instead of canned server responses. */
  api?: (call: ApiCall) => Promise<Response>;
};

/** Storage and tabs can be shared between fresh VM instances to simulate a killed SW. */
export async function backgroundHarness(bundle: string, opts: HarnessOptions = {}) {
  let now = Date.parse("2026-10-02T08:00:00.000Z"), nextTimer = 1, nextTab = 1000;
  const timers = new Map<number, { due: number; callback: Listener; interval?: number }>();
  const calls: ApiCall[] = [], unknownRequests: string[] = [], warnings: string[] = [];
  const created: Tab[] = [], removed: number[] = [], updated: Array<{ id: number; args: any }> = [];
  const tabMessages: Array<{ id: number; message: any }> = [];
  const debuggerCalls: Array<{ target: any; command: string; params?: any }> = [];
  const jobs = structuredClone(opts.jobs ?? []), tasks = structuredClone(opts.tasks ?? []);
  const keywordStates = structuredClone(opts.keywordStates ?? {});
  let keywordClaim = structuredClone(opts.keywordClaim ?? null);
  const liveTabs = structuredClone(opts.tabs ?? [{ id: 6, url: "https://www.xiaohongshu.com/explore" }]);
  nextTab = Math.max(nextTab, ...liveTabs.map(tab => tab.id + 1));
  const local = opts.local ?? fixtureStorage({ auth: { apiBase: fixtureBase, token: "old-fixture", epoch: fixtureEpoch }, swId: "fixture-sw" });
  const session = opts.session ?? fixtureStorage({ swId: "fixture-sw" });
  const controls = { failResults: false, failKeywordFinish: false,
    login: { loggedIn: true, userId: fixtureAccount, nickname: "Fixture", avatar: "" },
    page: { state: "blocked", reason: "CAPTCHA", cards: [], exhausted: false } as any };
  const response = (body: any, status = 200) => ({ status, ok: status >= 200 && status < 300,
    json: async () => structuredClone(body), text: async () => JSON.stringify(body) });
  const fetch = async (input: string, init: any = {}) => {
    const url = new URL(input), path = url.pathname;
    const body = init.body ? JSON.parse(init.body) : undefined;
    const call = { url: input, path, body, method: init.method ?? "GET", authorization: init.headers?.Authorization };
    calls.push(call);
    // Explicitly mocked homepage fallback, never sent to a real platform.
    if (input === "https://www.xiaohongshu.com/") return response({});
    if (url.origin !== fixtureBase) { unknownRequests.push(input); throw new Error("Unexpected offline URL: " + input); }
    if (opts.api) return opts.api(call);
    if (path === "/api/ext/accounts/heartbeat") return response({ ok: true });
    if (path === "/api/ext/publish/pending") return response({ jobs: jobs.filter(job => job.status === "pending") });
    if (path === "/api/ext/tasks/pending") return response({ tasks: tasks.filter(task => task.status === "queued") });
    if (path === "/api/ext/collection-tasks/claim") { const result = keywordClaim; keywordClaim = null; return response({ claim: result }); }
    const publication = /^\/api\/ext\/publish\/(\d+)(?:\/(claim|heartbeat|result))?$/.exec(path);
    if (publication) {
      const job = jobs.find(job => job.id === Number(publication[1]));
      if (!job) return response({ error: "not found" }, 404);
      if (publication[2] === "claim") {
        Object.assign(job, lease((job.attempt ?? 0) + 1), { status: "running", claimedBy: body.claimedBy });
        return response({ ok: true, ...job });
      }
      if (publication[2] === "heartbeat") return response({ ok: true, ...job });
      if (publication[2] === "result") {
        if (controls.failResults) throw new Error("fixture network unavailable");
        job.status = body.status; return response({ ok: true });
      }
      if (job.status !== "pending" && job.status !== "running") return response({ error: "job is terminal" }, 409);
      if (job.status === "running" && url.searchParams.get("claimer") !== job.claimedBy) return response({ error: "different publication owner" }, 409);
      return response(job);
    }
    const attribution = /^\/api\/ext\/tasks\/(\d+)(?:\/(claim|heartbeat|result))?$/.exec(path);
    if (attribution) {
      const task = tasks.find(task => task.id === Number(attribution[1]));
      if (!task) return response({ error: "not found" }, 404);
      if (attribution[2] === "claim") {
        Object.assign(task, lease((task.attempt ?? 0) + 1), { status: "processing", claimedBy: body.claimedBy });
        return response({ ok: true, ...task });
      }
      if (attribution[2] === "heartbeat") return response({ ok: true, ...task });
      if (attribution[2] === "result") {
        if (controls.failResults) throw new Error("fixture network unavailable");
        task.status = body.status; return response({ ok: true });
      }
      if (task.status !== "queued" && task.status !== "processing") return response({ error: "task is terminal" }, 409);
      if (task.status === "processing" && url.searchParams.get("claimer") !== task.claimedBy) return response({ error: "different attribution owner" }, 409);
      return response(task);
    }
    const collection = /^\/api\/(?:ext\/)?collection-tasks\/(\d+)(?:\/(heartbeat|finish))?$/.exec(path);
    if (collection) {
      const id = Number(collection[1]);
      const task = keywordStates[id];
      if (!task) return response({ error: "not found" }, 404);
      if (collection[2] === "finish") {
        if (controls.failKeywordFinish) throw new Error("fixture finish network unavailable");
        if (body.revision !== task.revision || task.status !== "running") return response({ error: "stale collection lease" }, 409);
        task.status = body.outcome === "blocked" ? "blocked" : body.outcome === "yield" ? "queued" : body.outcome;
      }
      return response({ task });
    }
    unknownRequests.push(input);
    throw new Error("Unexpected offline path: " + path);
  };
  const chrome = {
    runtime: { getManifest: () => ({ version: "0.1.9", content_scripts: [] }), onMessage: event(), onInstalled: event(), onStartup: event() },
    storage: { local, session, onChanged: event() },
    alarms: { onAlarm: event(), get: async () => ({ name: "existing-alarm" }), create: async () => {} },
    tabs: { onUpdated: event(), onRemoved: event(),
      query: async (query: any = {}) => structuredClone(liveTabs.filter(tab => {
        if (!query.url) return true;
        const patterns = Array.isArray(query.url) ? query.url : [query.url];
        return patterns.some((pattern: string) => pattern.includes("creator.") ? tab.url?.includes("creator.xiaohongshu.com")
          : pattern.includes("www.") ? tab.url?.includes("www.xiaohongshu.com") : tab.url?.includes("xiaohongshu.com"));
      })),
      get: async (id: number) => { const tab = liveTabs.find(tab => tab.id === id); if (!tab) throw new Error("no tab"); return structuredClone(tab); },
      create: async (args: any) => { const tab = { id: nextTab++, ...structuredClone(args) }; liveTabs.push(tab); created.push(tab); return structuredClone(tab); },
      remove: async (id: number) => { removed.push(id); const i = liveTabs.findIndex(tab => tab.id === id); if (i >= 0) liveTabs.splice(i, 1); chrome.tabs.onRemoved.emit(id, { isWindowClosing: false }); },
      update: async (id: number, args: any) => { updated.push({ id, args: structuredClone(args) }); const tab = liveTabs.find(tab => tab.id === id); if (!tab) throw new Error("no tab"); return Object.assign(tab, args); },
      sendMessage: async (id: number, message: any) => { tabMessages.push({ id, message: structuredClone(message) });
        if (message.type === "GET_LOGIN_STATE") return { ok: true, data: structuredClone(controls.login) };
        if (message.type === "COLLECTION_PAGE") return { ok: true, data: structuredClone(controls.page) };
        return { ok: true };
      },
    },
    debugger: { attach: async (target: any) => { debuggerCalls.push({ target, command: "attach" }); },
      detach: async (target: any) => { debuggerCalls.push({ target, command: "detach" }); },
      sendCommand: async (target: any, command: string, params: any) => { debuggerCalls.push({ target, command, params });
        return command === "Runtime.evaluate" ? { result: { value: [100, 100, ""] } } : {};
      },
    }, cookies: { get: async () => null },
  };
  const addTimer = (callback: Listener, delay = 0, interval?: number) => { const id = nextTimer++; timers.set(id, { callback, due: now + delay, interval }); return id; };
  class FixtureDate extends Date { constructor(value?: any) { super(value === undefined ? now : value); } static now() { return now; } }
  const context = vm.createContext({ chrome, fetch, URL, Date: FixtureDate, crypto: webcrypto, structuredClone,
    console: { warn: (...args: any[]) => warnings.push(args.map(String).join(" ")), log: () => {} },
    setTimeout: (fn: Listener, ms?: number) => addTimer(fn, ms), clearTimeout: (id: number) => timers.delete(id),
    setInterval: (fn: Listener, ms: number) => addTimer(fn, ms, ms), clearInterval: (id: number) => timers.delete(id),
    btoa: (text: string) => Buffer.from(text, "binary").toString("base64"),
  });
  const settle = async () => { for (let i = 0; i < 500; i++) await Promise.resolve(); };
  const advance = async (ms: number) => {
    const end = now + ms;
    for (let turns = 0; turns < 1000; turns++) {
      const next = [...timers.entries()].filter(([, timer]) => timer.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      now = next[1].due; timers.delete(next[0]);
      if (next[1].interval) timers.set(next[0], { ...next[1], due: now + next[1].interval });
      next[1].callback(); await settle();
    }
    now = end; await settle();
  };
  vm.runInContext(bundle, context);
  await settle();
  const message = async (body: Record<string, any>, tabId?: number, senderExtra: Record<string, any> = {}) => {
    const tab = tabId === undefined ? undefined : liveTabs.find(tab => tab.id === tabId) ?? { id: tabId };
    let answered = false, answer: any;
    chrome.runtime.onMessage.emit(body, { ...(tab ? { tab: structuredClone(tab) } : {}), ...senderExtra }, (value: any) => { answered = true; answer = value; });
    for (let turns = 0; !answered && turns < 100; turns++) { await settle(); await advance(100); }
    if (!answered) throw new Error("Fixture message did not receive a response: " + body.type);
    await settle(); return answer;
  };
  const alarm = async () => { chrome.alarms.onAlarm.emit({ name: "v2m-publish-poll" }); await settle(); };
  return { chrome, local, session, calls, unknownRequests, warnings, created, removed, updated, liveTabs, debuggerCalls, tabMessages,
    jobs, tasks, controls, keywordStates, message, alarm, settle, advance,
    resultCalls: (path: string) => calls.filter(call => call.path === path),
    dispose: () => timers.clear(),
  };
}
