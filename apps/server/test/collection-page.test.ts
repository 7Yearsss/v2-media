/// <reference types="chrome" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { taskCard } from "./fixtures/collection-card";
const state = vi.hoisted(() => ({ main: vi.fn(), listener: null as any, store: new Map<string, string>(), text: "" }));
vi.mock("../../extension/src/lib/messages", () => ({ mainRequest: state.main }));
vi.mock("../../extension/src/lib/ui", () => ({ el: () => ({}), shadowHost: () => ({ shadow: { append() {} } }) }));
describe("XHS 任务页适配器（DOM 与嗅探 RPC 模拟）", () => {
  beforeEach(() => { vi.resetModules(); state.listener = null; state.store.clear(); state.text = "";
    state.main.mockReset().mockImplementation(async action => action === "loginState" ? { loggedIn: true } : { cards: [], details: [], comments: {}, commentsHasMore: {} });
    vi.stubGlobal("location", new URL("https://www.xiaohongshu.com/search_result?keyword=test&__v2m_collect_task=1&__v2m_lease=lease"));
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => state.store.get(k) ?? null, setItem: (k: string, v: string) => state.store.set(k, v) });
    vi.stubGlobal("document", { body: { get innerText() { return state.text; } }, querySelectorAll: () => [], scrollingElement: { clientHeight: 800, scrollBy: vi.fn() } });
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener: (fn: any) => state.listener = fn } } }); });
  afterEach(() => vi.unstubAllGlobals());
  const rpc = (command = {}) => new Promise<any>(resolve => state.listener({ type: "COLLECTION_PAGE", leaseId: "lease", action: "read", ...command }, {}, resolve));
  it("nonce 不匹配不读缓存；任务页标记在重定向后仍能隔离普通采集", async () => {
    await import("../../extension/src/platforms/xhs/collection-page");
    const rejected = await rpc({ leaseId: "old" }); expect(rejected.ok).toBe(false); expect(state.main).not.toHaveBeenCalled(); expect(state.store.get("v2m_collection_page")).toContain('"lease":"lease"');
  });
  it("验证码和未登录均暂停，不请求详情、不滚动重试验证", async () => {
    await import("../../extension/src/platforms/xhs/collection-page"); state.text = "请完成验证";
    expect((await rpc({ action: "scroll" })).data.state).toBe("blocked"); expect(state.main).not.toHaveBeenCalled();
    state.text = ""; state.main.mockResolvedValueOnce({ loggedIn: false });
    expect((await rpc()).data.state).toBe("login_required"); expect(state.main.mock.calls.map(c => c[0])).toEqual(["loginState"]);
  });
  it("缓存详情合并主评/回复并保留 hasMore，返回标准业务字段", async () => {
    const card = taskCard();
    state.main.mockImplementation(async action => action === "loginState" ? { loggedIn: true } : { cards: [card], details: [{ ...card, content: "步骤", images: [], tags: [], commentsData: [] }], comments: { [card.noteId]: [{ commentId: "c", userName: "a", content: "真实评论", likes: 1 }] }, commentsHasMore: { [card.noteId]: false } });
    await import("../../extension/src/platforms/xhs/collection-page"); const result = await rpc({ noteId: card.noteId });
    expect(result.ok).toBe(true); expect(result.data.detail.commentsData).toHaveLength(1); expect(result.data.commentsHasMore).toBe(false);
  });
});
