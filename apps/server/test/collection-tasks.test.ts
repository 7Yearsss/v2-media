import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { COLLECTION_CAPABILITY, type CollectionTaskClaim, type NoteCard, type NoteDetail, type CollectionPageSnapshot } from "@v2media/shared";
import { makeApp, registerUser, authed } from "./helpers";
import { collectedNotes, collectionTasks, collectionTaskItems } from "../src/db/schema";
import { KeywordRunner } from "../../extension/src/lib/keyword-runner";
import { BrowserLane } from "../../extension/src/lib/browser-lane";
import { taskCard, taskNoteId as noteId } from "./fixtures/collection-card";
const detail = (n = 1): NoteDetail => ({ ...taskCard(n), content: "真实步骤", tags: ["备餐"], images: [{ url: "https://cdn.test/image" }], commentsData: [] });
async function fixture() {
  const { app, db, deps } = await makeApp(); const auth = await registerUser(app); let now = new Date("2026-10-02T08:00:00Z"); deps.now = () => now;
  const request = (path: string, body?: unknown) => app.request(path, authed(auth.token, { method: body === undefined ? "GET" : "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const json = async <T = any>(path: string, body?: unknown): Promise<T> => { const r = await request(path, body); if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`); return r.json() as Promise<T>; };
  const col = await json("/api/collections", { name: "备餐" });
  const create = (opts = {}) => json("/api/collection-tasks", { keyword: "下班备餐", collectionId: col.id, minLikes: 1000, scanLimit: 10, saveLimit: 2, commentLimit: 0, intervalMs: 2000, ...opts });
  const claim = async () => (await json<{ claim: CollectionTaskClaim | null }>("/api/ext/collection-tasks/claim", { capability: COLLECTION_CAPABILITY, claimedBy: "test-browser" })).claim;
  return { app, db, deps, auth, request, json, col, create, claim, setNow: (date: Date) => now = date };
}
const lease = (c: CollectionTaskClaim) => ({ leaseId: c.leaseId, revision: c.task.revision });

describe("持久关键词任务 + 插件执行器（离线模拟）", () => {
  it("能力、规则、归属和容量校验；按用户仅一租约，旧插件不误领", async () => {
    const f = await fixture(); await f.create();
    expect((await f.request("/api/ext/collection-tasks/claim", { claimedBy: "old" })).status).toBe(400);
    const c = await f.claim(); expect(c?.task.status).toBe("running"); expect(await f.claim()).toBeNull();
    const other = await registerUser(f.app, "other@b.co");
    expect((await f.app.request(`/api/collection-tasks/${c!.task.id}`, authed(other.token))).status).toBe(404);
    expect((await f.app.request("/api/collection-tasks", authed(other.token, { method: "POST", body: JSON.stringify({ keyword: "a", collectionId: f.col.id }) }))).status).toBe(404);
    expect((await f.request("/api/collection-tasks", { keyword: "a", collectionId: f.col.id, scanLimit: 2, saveLimit: 3 })).status).toBe(400);
    const pending = await f.json("/api/ext/tasks/pending"); expect(pending.tasks).toEqual([]);
    for (let i = 0; i < 9; i++) await f.create();
    expect((await f.request("/api/collection-tasks", { keyword: "a", collectionId: f.col.id })).status).toBe(409);
  });
  it("重复卡片去重、点赞边界、扫描上限和错误 URL；规则/库保持快照", async () => {
    const f = await fixture(); await f.create({ scanLimit: 3, saveLimit: 2 }); const c = (await f.claim())!;
    const r = await f.json(`/api/ext/collection-tasks/${c.task.id}/discover`, { ...lease(c), cards: [taskCard(1, 999), taskCard(2, 1000), taskCard(2, 1000), taskCard(3, 1001), taskCard(4)], scrollSteps: 1 });
    expect(r.task.counts).toMatchObject({ discovered: 3, skipped: 1, pending: 2 }); expect(r.task.phase).toBe("details"); expect(r.pending).toHaveLength(2);
    await f.json(`/api/ext/collection-tasks/${c.task.id}/discover`, { ...lease(c), cards: [taskCard(2)], scrollSteps: 2 });
    expect((await f.json(`/api/collection-tasks/${c.task.id}`)).task.counts.discovered).toBe(3);
    const bad = { ...taskCard(5), url: "https://evil.invalid/explore/" + noteId(5) };
    expect((await f.request(`/api/ext/collection-tasks/${c.task.id}/discover`, { ...lease(c), cards: [bad], scrollSteps: 2 })).status).toBe(400);
  });
  it("暂停/取消撤销租约，迟到入库拒绝；过期租约恢复 checkpoint，旧租约不可复活", async () => {
    const f = await fixture(); const t = await f.create(); const c = (await f.claim())!;
    await f.json(`/api/ext/collection-tasks/${t.id}/discover`, { ...lease(c), cards: [taskCard()], scrollSteps: 2, exhausted: true });
    const paused = await f.json(`/api/collection-tasks/${t.id}/control`, { revision: c.task.revision, action: "pause" });
    expect((await f.request(`/api/ext/collection-tasks/${t.id}/item`, { ...lease(c), noteId: noteId(1), detail: detail() })).status).toBe(409);
    const queued = await f.json(`/api/collection-tasks/${t.id}/control`, { revision: paused.revision, action: "resume" }); expect(queued.counts.discovered).toBe(1);
    const fresh = (await f.claim())!; expect(fresh.leaseId).not.toBe(c.leaseId); expect(fresh.task.scrollSteps).toBe(2); expect(fresh.pending).toHaveLength(1);
    f.setNow(new Date("2026-10-02T08:03:00Z")); const recovered = (await f.claim())!; expect(recovered.leaseId).not.toBe(fresh.leaseId);
    expect((await f.request(`/api/ext/collection-tasks/${t.id}/heartbeat`, lease(fresh))).status).toBe(409);
    await f.json(`/api/collection-tasks/${t.id}/control`, { revision: recovered.task.revision, action: "cancel" });
    expect((await f.request(`/api/ext/collection-tasks/${t.id}/item`, { ...lease(recovered), noteId: noteId(1), detail: detail() })).status).toBe(409);
    expect(await f.db.select().from(collectedNotes)).toHaveLength(0);
  });
  it("原子幂等入库、评论上限含回复；不把一页当全量，部分评论恢复不重复新增", async () => {
    const f = await fixture(); const t = await f.create({ saveLimit: 1, commentLimit: 2 }); const c = (await f.claim())!;
    await f.json(`/api/ext/collection-tasks/${t.id}/discover`, { ...lease(c), cards: [taskCard()], scrollSteps: 0, exhausted: true });
    const d = { ...detail(), comments: 5, commentsData: [{ commentId: "c1", userName: "a", content: "真实评论", likes: 1, subCommentCount: 3,
      subComments: [{ commentId: "r1", userName: "b", content: "回复", likes: 0 }, { commentId: "r2", userName: "c", content: "回复2", likes: 0 }] }] };
    await f.json(`/api/ext/collection-tasks/${t.id}/item`, { ...lease(c), noteId: noteId(1), detail: d, commentsHasMore: false });
    await f.json(`/api/ext/collection-tasks/${t.id}/item`, { ...lease(c), noteId: noteId(1), detail: d, commentsHasMore: false });
    const partial = await f.json(`/api/ext/collection-tasks/${t.id}/finish`, { ...lease(c), outcome: "done" });
    expect(partial.task.status).toBe("partial"); expect(partial.task.counts).toMatchObject({ saved: 1, newNotes: 1, comments: 1, replies: 1, partial: 1 });
    await f.json(`/api/collection-tasks/${t.id}/control`, { revision: partial.task.revision, action: "resume" }); const retry = (await f.claim())!; expect(retry.pending).toHaveLength(1);
    await f.json(`/api/ext/collection-tasks/${t.id}/item`, { ...lease(retry), noteId: noteId(1), detail: { ...detail(), comments: 0 }, commentsHasMore: false });
    const done = await f.json(`/api/ext/collection-tasks/${t.id}/finish`, { ...lease(retry), outcome: "done" }); expect(done.task.status).toBe("done"); expect(done.task.counts.newNotes).toBe(1);
    const rows = await f.db.select().from(collectedNotes); expect(rows).toHaveLength(1); expect(rows[0]!.commentsData).toHaveLength(1); expect(rows[0]!.sourceKeyword).toBe("下班备餐");
  });
  it("目标库删除不会静默改到其他库；blocked 阻止队列继续，取消后保留已采记录", async () => {
    const f = await fixture(); const t = await f.create(); await f.create(); const c = (await f.claim())!;
    const blocked = await f.json(`/api/ext/collection-tasks/${t.id}/finish`, { ...lease(c), outcome: "blocked", reason: "需要验证码" }); expect(await f.claim()).toBeNull();
    await f.json(`/api/collection-tasks/${t.id}/control`, { revision: blocked.task.revision, action: "cancel" }); expect(await f.claim()).not.toBeNull();
    await f.app.request(`/api/collections/${f.col.id}`, authed(f.auth.token, { method: "DELETE" }));
    const rows = await f.db.select().from(collectionTasks); expect(rows.every(r => r.collectionId === null)).toBe(true);
  });
  it("真实 KeywordRunner 串起搜索→筛选→详情→入库，未确认评论为部分，标签页串行", async () => {
    const f = await fixture(); const t = await f.create({ commentLimit: 0 }); let ticks = 0, opened = 0, concurrent = 0, maxConcurrent = 0; const lane = new BrowserLane();
    const runner = new KeywordRunner({ api: f.json, ownerId: async () => "sim", enabled: async () => true, reserve: async owner => lane.acquire(owner), release: owner => lane.release(owner),
      priorityWaiting: async () => false, open: async () => { opened++; concurrent++; maxConcurrent = Math.max(maxConcurrent, concurrent); return opened; }, close: async () => { concurrent--; }, focus: async () => {},
      sleep: async ms => { ticks += ms; }, now: () => ticks, block: async () => {}, page: async (_id, _lease, _action, n): Promise<CollectionPageSnapshot> => n
        ? { state: "ready", cards: [], detail: detail(parseInt(n, 16)), commentsHasMore: false, exhausted: false }
        : { state: "ready", keyword: "下班备餐", cards: [taskCard(1, 999), taskCard(2), taskCard(3, 1001)], exhausted: true } });
    await runner.run(); const task = (await f.json(`/api/collection-tasks/${t.id}`)).task;
    expect(task.status).toBe("done"); expect(task.counts).toMatchObject({ discovered: 3, skipped: 1, saved: 2, newNotes: 2 }); expect(maxConcurrent).toBe(1); expect(concurrent).toBe(0);
  });
  it("执行器在验证码暂停且不重试绕过；优先级让位保存 checkpoint，恢复不重复入库", async () => {
    const f = await fixture(); const t = await f.create(); let priority = false, captcha = false, blockCount = 0, calls = 0;
    const driver = { api: f.json, ownerId: async () => "sim", enabled: async () => true, reserve: async () => true, release: () => {}, priorityWaiting: async () => priority,
      open: async () => ++calls, close: async () => {}, focus: async () => {}, sleep: async () => {}, now: () => 0,
      block: async () => { blockCount++; }, page: async (_id: number, _lease: string, _action: "read" | "scroll", n?: string): Promise<CollectionPageSnapshot> => {
        if (captcha) return { state: "blocked", reason: "需要验证码", cards: [], exhausted: false };
        if (n) return { state: "ready", cards: [], detail: detail(), exhausted: false };
        priority = true; return { state: "ready", keyword: "下班备餐", cards: [taskCard()], exhausted: true }; } };
    await new KeywordRunner(driver).run(); let task = (await f.json(`/api/collection-tasks/${t.id}`)).task; expect(task.status).toBe("queued"); expect(task.counts.discovered).toBe(1);
    priority = false; captcha = true; const before = calls; await new KeywordRunner(driver).run(); task = (await f.json(`/api/collection-tasks/${t.id}`)).task;
    expect(task.status).toBe("blocked"); expect(blockCount).toBe(1); expect(calls - before).toBe(1); expect(await f.db.select().from(collectedNotes)).toHaveLength(0);
    await f.json(`/api/collection-tasks/${t.id}/control`, { revision: task.revision, action: "resume" }); captcha = false;
    await new KeywordRunner(driver).run(); task = (await f.json(`/api/collection-tasks/${t.id}`)).task; expect(task.counts).toMatchObject({ discovered: 1, saved: 1 });
  });
  it("页面响应期间取消，执行器迟到数据不会写入；浏览器槽不能被其他 owner 释放", async () => {
    const f = await fixture(); const t = await f.create();
    const runner = new KeywordRunner({ api: f.json, ownerId: async () => "sim", enabled: async () => true, reserve: async () => true, release: () => {}, priorityWaiting: async () => false,
      open: async () => 1, close: async () => {}, focus: async () => {}, sleep: async () => {}, now: () => 0, block: async () => {},
      page: async (_id, _lease, _action, n): Promise<CollectionPageSnapshot> => {
        if (n) { const current = await f.json(`/api/collection-tasks/${t.id}`); await f.json(`/api/collection-tasks/${t.id}/control`, { revision: current.task.revision, action: "cancel" }); return { state: "ready", cards: [], detail: detail(), exhausted: false }; }
        return { state: "ready", keyword: "下班备餐", cards: [taskCard()], exhausted: true }; } });
    await runner.run(); expect((await f.json(`/api/collection-tasks/${t.id}`)).task.status).toBe("canceled"); expect(await f.db.select().from(collectedNotes)).toHaveLength(0);
    const lane = new BrowserLane(); expect(lane.acquire("publish:1")).toBe(true); expect(lane.acquire("keyword")).toBe(false); lane.release("keyword"); expect(lane.busy).toBe(true); lane.release("publish:1"); expect(lane.busy).toBe(false);
  });
});
