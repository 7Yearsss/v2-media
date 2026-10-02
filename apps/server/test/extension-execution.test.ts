import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { BROWSER_EXECUTION_CAPABILITY } from "@v2media/shared";
import { eq } from "drizzle-orm";
import { makeApp, registerUser, authed } from "./helpers";
import { browserExecutionReceipts, drafts, hostedAccounts, jobs, publishJobs } from "../src/db/schema";
import { backgroundHarness, bundleBackground, fixtureAccount, fixtureBase, fixtureEpoch, fixtureNote, fixtureStorage, keywordFixture,
  publishFixture, taskFixture } from "./fixtures/extension-background";

let bundle: string;
const running: Awaited<ReturnType<typeof backgroundHarness>>[] = [];
beforeAll(async () => { bundle = await bundleBackground(); });
afterEach(() => { for (const harness of running.splice(0)) harness.dispose(); });
async function fixture(opts: Parameters<typeof backgroundHarness>[1] = {}) {
  const harness = await backgroundHarness(bundle, opts); running.push(harness); return harness;
}
const taskTabs = (f: Awaited<ReturnType<typeof fixture>>, id: number) => f.liveTabs.filter(tab => tab.url?.includes(`__v2m_task=${id}`));
const publishTabs = (f: Awaited<ReturnType<typeof fixture>>, id = 101) => f.liveTabs.filter(tab => tab.url?.includes(`job_id=${id}`));
function fenced(body: any) {
  expect(body).toMatchObject({ capability: BROWSER_EXECUTION_CAPABILITY, claimedBy: "fixture-sw", attempt: 1 });
  expect(body.leaseId).toMatch(/^[0-9a-f-]{36}$/i);
  expect(body.receiptId).toMatch(/^[0-9a-f-]{36}$/i);
}

describe("actual MV3 background execution and crash recovery (offline)", () => {
  it("the publishing owner may dispatch a real click; an unrelated tab cannot", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm();
    const tab = publishTabs(f)[0]; expect(tab).toBeDefined();
    expect(await f.message({ type: "JOB_READY", jobId: 101 }, tab!.id)).toMatchObject({ ok: true });
    expect(await f.message({ type: "TRUSTED_CLICK", x: 0, y: 0, selectors: ["xhs-publish-btn"] }, tab!.id))
      .toMatchObject({ ok: true, data: { ok: true } });
    expect(f.debuggerCalls.filter(call => call.command === "Input.dispatchMouseEvent")).toHaveLength(3);
    const count = f.debuggerCalls.length;
    expect(await f.message({ type: "TRUSTED_CLICK", x: 100, y: 100 }, 6)).toMatchObject({ ok: true, data: { ok: false } });
    expect(f.debuggerCalls).toHaveLength(count);
    expect(f.unknownRequests).toEqual([]);
  });

  it("JOB_READY after a cold start binds the existing publisher tab and grants it once", async () => {
    const original = await fixture({ jobs: [publishFixture()] }); await original.alarm();
    const id = publishTabs(original)[0]!.id;
    const f = await fixture({ jobs: original.jobs, tabs: original.liveTabs, local: original.local, session: original.session });
    expect(await f.message({ type: "JOB_READY", jobId: 101 }, id)).toMatchObject({ ok: true, data: { payload: { id: 101 } } });
    expect(await f.message({ type: "TRUSTED_CLICK", x: 25, y: 25 }, id)).toMatchObject({ ok: true, data: { ok: true } });
    const recovery = await fixture({ jobs: f.jobs, tabs: f.liveTabs, local: f.local, session: f.session });
    expect(await recovery.message({ type: "JOB_READY", jobId: 101 }, id)).toMatchObject({ ok: false });
    expect(recovery.tabMessages.filter(call => call.message.type === "JOB_PAYLOAD")).toEqual([]);
    expect(recovery.created).toEqual([]);
    expect(recovery.unknownRequests).toEqual([]);
  });

  it("startup reconciliation removes an expired keyword tab before selecting a pending publication", async () => {
    const f = await fixture({ jobs: [publishFixture()], keywordStates: { 5: keywordFixture(5, 2, "queued") }, tabs: [
      { id: 7, url: "https://www.xiaohongshu.com/search_result?keyword=fixture&__v2m_collect_task=5&__v2m_lease=expired" },
    ] });
    f.chrome.runtime.onStartup.emit(); await f.settle();
    expect(f.removed).toContain(7);
    expect(f.resultCalls("/api/ext/publish/101/claim")).toHaveLength(1);
    expect(publishTabs(f)).toHaveLength(1);
    expect(f.unknownRequests).toEqual([]);
  });

  it("reclaiming the same attribution task leaves no orphan page and permits the next publication", async () => {
    const f = await fixture({ tasks: [taskFixture()], tabs: [
      { id: 8, url: `https://www.xiaohongshu.com/explore/${fixtureNote}?__v2m_task=86&__v2m_lease=expired` },
    ] });
    await f.alarm(); expect(taskTabs(f, 86)).toHaveLength(1);
    const tab = taskTabs(f, 86)[0]!;
    await f.message({ type: "TASK_DATA", taskId: 86, data: { noteId: fixtureNote, likes: 0, collects: 0, comments: 0, shares: 0 } }, tab.id);
    await f.settle(); expect(taskTabs(f, 86)).toHaveLength(0);
    fenced(f.resultCalls("/api/ext/tasks/86/result")[0]?.body);
    f.jobs.push(publishFixture()); await f.alarm();
    expect(publishTabs(f), JSON.stringify({ calls: f.calls, warnings: f.warnings, state: f.local.data, tabs: f.liveTabs })).toHaveLength(1);
    expect(f.unknownRequests).toEqual([]);
  });

  it("CAPTCHA persists a local stop and keeps its page when finish is offline; later tasks cannot navigate", async () => {
    const task = keywordFixture();
    const f = await fixture({ keywordClaim: { task, leaseId: "keyword-lease", pending: [] }, keywordStates: { 5: task } });
    f.controls.failKeywordFinish = true; await f.alarm(); await f.advance(3000);
    expect(f.resultCalls("/api/ext/collection-tasks/5/finish").length,
      JSON.stringify({ calls: f.calls, warnings: f.warnings, created: f.created })).toBeGreaterThanOrEqual(1);
    expect(f.local.data.collectionSafetyBlock).toMatchObject({ taskId: 5, leaseId: "keyword-lease", context: { apiBase: fixtureBase, epoch: fixtureEpoch } });
    const verification = f.liveTabs.find(tab => tab.url?.includes("__v2m_collect_task=5")); expect(verification).toBeDefined();
    const created = f.created.length; f.jobs.push(publishFixture()); await f.alarm(); await f.advance(60_000);
    expect(f.created).toHaveLength(created);
    expect(f.resultCalls("/api/ext/publish/101/claim")).toHaveLength(0);
    expect(f.liveTabs.some(tab => tab.id === verification!.id)).toBe(true);
    // Server lease expiry can requeue this task, but is not an instruction to bypass CAPTCHA.
    Object.assign(f.keywordStates[5], { status: "queued", revision: 2, controlRevision: 0, lastControlAction: null, reason: null });
    await f.alarm(); expect(f.created).toHaveLength(created);
    expect(f.local.data.collectionSafetyBlock).toBeDefined();
    const recovery = await fixture({ jobs: f.jobs, tabs: f.liveTabs, local: f.local, session: f.session, keywordStates: f.keywordStates });
    recovery.controls.failKeywordFinish = true; await recovery.alarm();
    expect(recovery.created).toHaveLength(0);
    expect(recovery.local.data.collectionSafetyBlock).toBeDefined();
    // The user's explicit resume is authoritative even while the old finish receipt remains stale.
    Object.assign(recovery.keywordStates[5], { status: "queued", revision: 3, controlRevision: 3, lastControlAction: "resume" });
    recovery.controls.failKeywordFinish = false; await recovery.alarm();
    expect(recovery.local.data.collectionSafetyBlock).toBeUndefined();
    expect(recovery.liveTabs.some(tab => tab.id === verification!.id)).toBe(false);
    expect(publishTabs(recovery)).toHaveLength(1);
    expect(recovery.unknownRequests).toEqual([]);
  });

  it("offline publication results survive SW death with a stable fenced receipt and never republish", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm();
    const tab = publishTabs(f)[0]!; await f.message({ type: "JOB_READY", jobId: 101 }, tab.id);
    f.controls.failResults = true;
    await f.message({ type: "JOB_RESULT", jobId: 101, status: "done", resultUrl: `https://www.xiaohongshu.com/explore/${fixtureNote}` }, tab.id);
    const first = f.resultCalls("/api/ext/publish/101/result")[0]!; fenced(first?.body);
    expect(f.local.data.browserResultOutbox).toHaveLength(1);
    const recovery = await fixture({ jobs: f.jobs, tabs: f.liveTabs, local: f.local, session: f.session }); await recovery.alarm();
    const resent = recovery.resultCalls("/api/ext/publish/101/result")[0]!;
    expect(resent?.body).toEqual(first.body);
    expect(recovery.created).toEqual([]);
    expect(recovery.resultCalls("/api/ext/publish/101/claim")).toEqual([]);
    expect(recovery.tabMessages.filter(call => call.message.type === "JOB_PAYLOAD")).toEqual([]);
    expect(recovery.local.data.browserResultOutbox ?? []).toHaveLength(0);
    expect(recovery.unknownRequests).toEqual([]);
  });

  it("actual background replays an ACK lost after the real Hono/PGlite publication transaction exactly once", async () => {
    const server = await makeApp(); const auth = await registerUser(server.app, "browser-seam@test.invalid");
    server.deps.now = () => new Date("2026-10-02T08:00:00.000Z");
    const [account] = await server.db.insert(hostedAccounts).values({ userId: auth.userId, xhsUserId: fixtureAccount, subType: "creator" }).returning();
    const [draft] = await server.db.insert(drafts).values({ userId: auth.userId, title: "Offline seam", content: "Only an in-memory test",
      images: [{ url: "https://offline.invalid/fixture.png" }] }).returning();
    const created = await server.app.request("/api/publish/jobs", authed(auth.token, { method: "POST", body: JSON.stringify({ draftId: draft!.id, accountId: account!.id }) }));
    expect(created.ok).toBe(true); const job = await created.json() as any;
    let lost = false;
    const api = async (call: any) => {
      const response = await server.app.request(call.url, {
        method: call.method, headers: { "Content-Type": "application/json", Authorization: call.authorization },
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      });
      if (call.path === `/api/ext/publish/${job.id}/result` && !lost) {
        expect(response.status).toBe(200); lost = true;
        throw new Error("Fixture lost ACK after the server committed");
      }
      return response;
    };
    const local = fixtureStorage({ auth: { apiBase: fixtureBase, token: auth.token, epoch: fixtureEpoch }, swId: "fixture-sw" });
    const f = await fixture({ api, local }); await f.alarm(); const tab = publishTabs(f, job.id)[0]!; expect(tab).toBeDefined();
    await f.message({ type: "JOB_READY", jobId: job.id }, tab.id);
    await f.message({ type: "TRUSTED_CLICK", x: 50, y: 50 }, tab.id);
    expect(f.calls.some(call => call.path === `/api/ext/publish/${job.id}/heartbeat`)).toBe(true);
    expect(await f.message({ type: "JOB_RESULT", jobId: job.id, status: "done", resultUrl: `https://www.xiaohongshu.com/explore/${fixtureNote}` }, tab.id)).toMatchObject({ ok: false });
    const originalReceipt = f.resultCalls(`/api/ext/publish/${job.id}/result`)[0]!.body; fenced(originalReceipt);
    expect(f.local.data.browserResultOutbox).toHaveLength(1);
    expect((await server.db.select().from(publishJobs).where(eq(publishJobs.id, job.id)))[0]!.status).toBe("done");
    const recovery = await fixture({ api, local: f.local, session: fixtureStorage(), tabs: f.liveTabs }); await recovery.alarm();
    expect(recovery.resultCalls(`/api/ext/publish/${job.id}/result`)[0]!.body).toEqual(originalReceipt);
    expect(recovery.created).toEqual([]);
    expect(recovery.tabMessages.filter(call => call.message.type === "JOB_PAYLOAD")).toEqual([]);
    expect(recovery.local.data.browserResultOutbox ?? []).toEqual([]);
    expect(await server.db.select().from(jobs).where(eq(jobs.type, "readback"))).toHaveLength(1);
    expect(await server.db.select().from(browserExecutionReceipts)).toHaveLength(1);
    expect((await server.db.select().from(drafts).where(eq(drafts.id, draft!.id)))[0]!.status).toBe("published");
    expect(recovery.unknownRequests).toEqual([]);
  });

  it("authorizing another user cannot transmit the previous auth epoch's outbox with the new token", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm(); const tab = publishTabs(f)[0]!;
    await f.message({ type: "JOB_READY", jobId: 101 }, tab.id); f.controls.failResults = true;
    await f.message({ type: "JOB_RESULT", jobId: 101, status: "done" }, tab.id);
    fenced(f.resultCalls("/api/ext/publish/101/result")[0]?.body);
    await f.message({ type: "SITE_SET_AUTH", apiBase: fixtureBase, token: "new-user-fixture" }, undefined, { origin: fixtureBase });
    f.controls.failResults = false; await f.alarm();
    expect(f.resultCalls("/api/ext/publish/101/result").filter(call => call.authorization === "Bearer new-user-fixture")).toEqual([]);
    expect(f.local.data.auth.epoch).not.toBe(fixtureEpoch);
    expect(f.unknownRequests).toEqual([]);
  });

  it("a publisher with an expired lease cannot dispatch another trusted mouse event", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm(); const tab = publishTabs(f)[0]!;
    await f.message({ type: "JOB_READY", jobId: 101 }, tab.id);
    await f.advance(10 * 60_000 + 1);
    expect(await f.message({ type: "TRUSTED_CLICK", x: 100, y: 100 }, tab.id)).toMatchObject({ ok: true, data: { ok: false } });
    expect(f.debuggerCalls.filter(call => call.command === "Input.dispatchMouseEvent")).toEqual([]);
    expect(f.unknownRequests).toEqual([]);
  });

  it("a delivered publication timeout stays uncertain, keeps its page, and cannot enable another publication", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm(); const tab = publishTabs(f)[0]!;
    await f.message({ type: "JOB_READY", jobId: 101 }, tab.id);
    f.jobs.push(publishFixture(102));
    await f.advance(10 * 60_000 + 1); await f.alarm();
    expect(f.resultCalls("/api/ext/publish/101/result")).toEqual([]);
    expect(f.local.data.browserResultOutbox ?? []).toEqual([]);
    expect(f.jobs.find(job => job.id === 101)?.status).toBe("running");
    expect(f.liveTabs.some(candidate => candidate.id === tab.id)).toBe(true);
    expect(f.resultCalls("/api/ext/publish/102/claim")).toEqual([]);
    expect(publishTabs(f, 102)).toEqual([]);
    expect(f.local.data.browserExecutions[0]).toMatchObject({ id: 101, phase: "uncertain", delivered: true });
    const status = await f.message({ type: "GET_STATUS" });
    expect(status).toMatchObject({ ok: true });
    expect(status.data.execution.blockedReason).toMatch(/核对|未知|不明确/);
    expect(f.unknownRequests).toEqual([]);
  });

  it("an uncertain post-click result retains evidence and cannot become a failed receipt or automatic retry", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm(); const tab = publishTabs(f)[0]!;
    await f.message({ type: "JOB_READY", jobId: 101 }, tab.id);
    expect(await f.message({ type: "TRUSTED_CLICK", x: 50, y: 50 }, tab.id)).toMatchObject({ ok: true, data: { ok: true } });
    expect(await f.message({ type: "JOB_RESULT", jobId: 101, status: "uncertain", error: "Publication was clicked; confirmation timed out" }, tab.id))
      .toMatchObject({ ok: true, data: { reported: true, reconciliationRequired: true } });
    expect(f.resultCalls("/api/ext/publish/101/result")).toEqual([]);
    expect(f.local.data.browserResultOutbox ?? []).toEqual([]);
    expect(f.local.data.browserExecutions[0]).toMatchObject({ id: 101, phase: "uncertain", delivered: true });
    expect(f.jobs[0].status).toBe("running");
    f.jobs.push(publishFixture(102)); await f.alarm();
    expect(f.liveTabs.some(candidate => candidate.id === tab.id)).toBe(true);
    expect(publishTabs(f, 102)).toEqual([]);
    const recovery = await fixture({ jobs: f.jobs, tabs: f.liveTabs, local: f.local, session: fixtureStorage() }); await recovery.alarm();
    expect(recovery.created).toEqual([]);
    expect(recovery.resultCalls("/api/ext/publish/101/result")).toEqual([]);
    expect(await recovery.message({ type: "JOB_READY", jobId: 101 }, tab.id)).toMatchObject({ ok: false });
    const status = await recovery.message({ type: "GET_STATUS" });
    expect(status.data.execution.blockedReason).toMatch(/核对|未知|不明确/);
    expect(recovery.unknownRequests).toEqual([]);
  });

  it("a full browser reload preserves a delivered publication's original lease owner without delivering it again", async () => {
    const original = await fixture({ jobs: [publishFixture()] }); await original.alarm(); const tab = publishTabs(original)[0]!;
    await original.message({ type: "JOB_READY", jobId: 101 }, tab.id);
    // The durable authority is the lease owner, even if a new lifecycle has a different instance ID.
    await original.local.set({ swId: "replacement-worker" });
    const recovery = await fixture({ jobs: original.jobs, tabs: original.liveTabs, local: original.local, session: fixtureStorage() });
    await recovery.alarm();
    const lookup = recovery.calls.find(call => call.path === "/api/ext/publish/101"); expect(lookup).toBeDefined();
    expect(new URL(lookup!.url).searchParams.get("claimer")).toBe("fixture-sw");
    expect(await recovery.message({ type: "JOB_READY", jobId: 101 }, tab.id)).toMatchObject({ ok: false });
    expect(recovery.created).toEqual([]);
    expect(recovery.tabMessages.filter(call => call.message.type === "JOB_PAYLOAD")).toEqual([]);
    expect(recovery.local.data.browserExecutions[0].tabId).toBe(tab.id);
    expect(recovery.local.data.browserExecutions[0].lease.claimedBy).toBe("fixture-sw");
    expect(await recovery.message({ type: "JOB_RESULT", jobId: 101, status: "done" }, tab.id)).toMatchObject({ ok: true });
    fenced(recovery.resultCalls("/api/ext/publish/101/result")[0]?.body);
    expect(recovery.unknownRequests).toEqual([]);
  });

  it("a read-only task is resumed after full browser reload using its original lease owner", async () => {
    const original = await fixture({ tasks: [taskFixture()] }); await original.alarm(); const tab = taskTabs(original, 86)[0]!;
    await original.local.set({ swId: "replacement-worker" });
    const recovery = await fixture({ tasks: original.tasks, tabs: original.liveTabs, local: original.local, session: fixtureStorage() });
    await recovery.alarm();
    const lookup = recovery.calls.find(call => call.path === "/api/ext/tasks/86"); expect(lookup).toBeDefined();
    expect(new URL(lookup!.url).searchParams.get("claimer")).toBe("fixture-sw");
    expect(recovery.created).toEqual([]);
    expect(taskTabs(recovery, 86)).toHaveLength(1);
    await recovery.message({ type: "TASK_DATA", taskId: 86, data: { noteId: fixtureNote, likes: 0 } }, tab.id);
    await recovery.settle(); fenced(recovery.resultCalls("/api/ext/tasks/86/result")[0]?.body);
    expect(taskTabs(recovery, 86)).toEqual([]);
    expect(recovery.local.data.browserExecutions ?? []).toEqual([]);
    expect(recovery.unknownRequests).toEqual([]);
  });

  it.each([
    { label: "another logged-in account", loggedIn: true, userId: "000000000000000000000099" },
    { label: "an unverifiable login", loggedIn: false, userId: "" },
  ])("fresh identity rejects clicks from the correct task tab after $label", async ({ loggedIn, userId }) => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm(); const tab = publishTabs(f)[0]!;
    await f.message({ type: "JOB_READY", jobId: 101 }, tab.id);
    // A successful claim has populated the short-lived identity cache; lastAccount is also stale.
    await f.local.set({ lastAccount: { xhsUserId: fixtureAccount, nickname: "Previously logged in" } });
    f.controls.login = { ...f.controls.login, loggedIn, userId };
    expect(await f.message({ type: "TRUSTED_CLICK", x: 100, y: 100 }, tab.id)).toMatchObject({ ok: true, data: { ok: false } });
    expect(f.debuggerCalls.filter(call => call.command === "Input.dispatchMouseEvent")).toEqual([]);
    expect(f.resultCalls("/api/ext/publish/101/result")).toEqual([]);
    expect(f.unknownRequests).toEqual([]);
  });

  it("a late JOB_RESULT from another page cannot finish or close the current publishing execution", async () => {
    const f = await fixture({ jobs: [publishFixture()] }); await f.alarm(); const current = publishTabs(f)[0]!;
    await f.message({ type: "JOB_READY", jobId: 101 }, current.id);
    // This tab carries the same job ID, but belongs to an obsolete execution.
    f.liveTabs.push({ id: 99, url: "https://creator.xiaohongshu.com/publish/publish?job_id=101&__v2m_execution=old" });
    expect(await f.message({ type: "JOB_RESULT", jobId: 101, status: "done" }, 99)).toMatchObject({ ok: false });
    expect(f.resultCalls("/api/ext/publish/101/result")).toEqual([]);
    expect(f.liveTabs.some(tab => tab.id === current.id)).toBe(true);
    expect(f.local.data.browserExecutions).toHaveLength(1);
    expect(f.local.data.browserExecutions[0].tabId).toBe(current.id);
    expect(f.unknownRequests).toEqual([]);
  });

  it("canceling active deep collection A does not discard queued B and C", async () => {
    const f = await fixture();
    const ids = [1, 2, 3].map(n => String(n).padStart(24, "0"));
    for (const id of ids) await f.message({ type: "DEEP_COLLECT", url: `https://www.xiaohongshu.com/explore/${id}` }, 6);
    const a = f.created.find(tab => tab.url?.includes(ids[0]!)); expect(a).toBeDefined();
    await f.message({ type: "DEEP_COLLECT_CANCEL", noteId: ids[0] }, 6);
    await f.message({ type: "COLLECT_URL_DONE", noteId: ids[0], ok: true }, a!.id);
    await f.settle();
    const b = f.created.find(tab => tab.url?.includes(ids[1]!)); expect(b).toBeDefined();
    await f.message({ type: "COLLECT_URL_DONE", noteId: ids[1], ok: true }, b!.id); await f.settle();
    const c = f.created.find(tab => tab.url?.includes(ids[2]!)); expect(c).toBeDefined();
    await f.message({ type: "COLLECT_URL_DONE", noteId: ids[2], ok: true }, c!.id); await f.settle();
    expect(f.created.map(tab => ids.find(id => tab.url?.includes(id)))).toEqual(ids);
    expect(f.local.data.browserExecutions ?? []).toHaveLength(0);
    expect(f.session.data.deepQueue ?? []).toEqual([]);
    expect(f.unknownRequests).toEqual([]);
  });
});
