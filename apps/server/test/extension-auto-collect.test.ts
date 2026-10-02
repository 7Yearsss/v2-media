/// <reference types="chrome" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteCard, NoteComment, NoteDetail } from "@v2media/shared";
import type { ExtSettings } from "../../extension/src/lib/settings";

const mocks = vi.hoisted(() => ({
  settings: { enabled: true, autoCollect: true, deepCollect: true, collectionId: null } as ExtSettings,
  change: null as null | ((settings: ExtSettings) => void),
  clicks: new Map<string, () => void>(),
  cached: [] as NoteCard[],
  cachedDetails: [] as NoteDetail[],
  cachedComments: {} as Record<string, NoteComment[]>,
  main: vi.fn(),
  send: vi.fn(),
  getSettings: vi.fn(),
}));

vi.mock("../../extension/src/lib/settings", () => ({
  getSettings: mocks.getSettings,
  onSettingsChanged: (callback: (settings: ExtSettings) => void) => { mocks.change = callback; },
}));
vi.mock("../../extension/src/lib/messages", () => ({
  EVT_NOTES: "v2m:notes",
  EVT_COMMENTS: "v2m:comments",
  mainRequest: mocks.main,
  sendToBackground: mocks.send,
}));
vi.mock("../../extension/src/lib/ui", () => {
  const node = (_tag?: string, _attrs?: unknown, text?: string) => ({
    style: {}, classList: { toggle() {} }, append() {}, addEventListener(event: string, cb: () => void) {
      if (event === "click" && text) mocks.clicks.set(text, cb);
    },
  });
  return { el: node, shadowHost: () => ({ shadow: node() }), toastIn: vi.fn() };
});

const card: NoteCard = {
  noteId: "6abbcea700000000130195e3", xsecToken: "test", type: "image",
  title: "自动采集测试", desc: "", author: { userId: "test", nickname: "test", avatar: "" },
  cover: "https://cdn.test/image", likes: 100, collects: 0, comments: 4, shares: 0,
  url: "https://www.xiaohongshu.com/explore/6abbcea700000000130195e3?xsec_token=test",
  source: "homefeed",
};

describe("插件自动采集通路（模拟浏览器，无外网）", () => {
  let doc: EventTarget;
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    mocks.settings = { enabled: true, autoCollect: true, deepCollect: true, collectionId: null };
    mocks.cached = [];
    mocks.cachedDetails = [];
    mocks.cachedComments = {};
    mocks.change = null;
    mocks.clicks.clear();
    mocks.main.mockReset().mockImplementation(async (action, params) => action === "getNote"
      ? { card: mocks.cached.find(n => n.noteId === params.noteId),
          detail: mocks.cachedDetails.find(n => n.noteId === params.noteId),
          comments: mocks.cachedComments[params.noteId], commentsHasMore: false }
      : { cards: mocks.cached, details: mocks.cachedDetails, comments: mocks.cachedComments });
    mocks.getSettings.mockReset().mockImplementation(async () => mocks.settings);
    mocks.send.mockReset().mockImplementation(async (msg) =>
      msg.type === "EXT_COLLECT" ? { saved: 1 } : { queued: true });
    doc = Object.assign(new EventTarget(), {
      documentElement: {}, querySelectorAll: () => [], querySelector: () => null,
      body: { innerText: "" },
    });
    vi.stubGlobal("document", doc);
    vi.stubGlobal("location", new URL("https://www.xiaohongshu.com/explore"));
    vi.stubGlobal("window", Object.assign(new EventTarget(), { setTimeout, clearTimeout }));
    vi.stubGlobal("MutationObserver", class { observe() {} });
    vi.stubGlobal("requestAnimationFrame", () => 0);
    vi.stubGlobal("innerWidth", 1280);
    vi.stubGlobal("innerHeight", 800);
    vi.stubGlobal("sessionStorage", { getItem: () => null, setItem() {} });
    vi.stubGlobal("chrome", { runtime: { onMessage: { addListener() {} } } });
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

  async function start() {
    await import("../../extension/src/content");
    await vi.advanceTimersByTimeAsync(0);
  }
  function emitCard(note = card) {
    doc.dispatchEvent(new CustomEvent("v2m:notes", {
      detail: { source: "homefeed", items: [note], details: [] },
    }));
  }
  const calls = (type: string) => mocks.send.mock.calls.filter(([msg]) => msg.type === type);

  it("关键词任务页不叠加普通自动入库和深度队列", async () => {
    vi.stubGlobal("location", new URL("https://www.xiaohongshu.com/search_result?keyword=test&__v2m_collect_task=1&__v2m_lease=lease"));
    await start(); emitCard(); await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0); expect(calls("DEEP_COLLECT")).toHaveLength(0);
  });

  it("热度门槛 999/1000/1001：只补详情、入库与排评论的达标笔记", async () => {
    mocks.settings.hotFilter = { enabled: true, minLikes: 1000 };
    await start();
    for (const likes of [999, 1000, 1001]) emitCard({ ...card, noteId: String(likes), likes });
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")[0]![0].batch.items.map((n: NoteCard) => n.likes)).toEqual([1000, 1001]);
    expect(calls("DEEP_COLLECT")).toHaveLength(2);
    expect(mocks.main.mock.calls.filter(([action]) => action === "fetchDetail")).toHaveLength(2);
  });

  it("独立低赞详情和评论不能绕过热度门槛", async () => {
    mocks.settings.hotFilter = { enabled: true, minLikes: 1000 };
    await start();
    doc.dispatchEvent(new CustomEvent("v2m:notes", { detail: {
      source: "detail", items: [], details: [{ ...card, content: "正文", tags: [], images: [] }],
    } }));
    doc.dispatchEvent(new CustomEvent("v2m:comments", { detail: { noteId: card.noteId, comments: [] } }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0);
  });

  it("去抖期间调高门槛拦住旧队列，调低后重评页面缓存", async () => {
    mocks.settings.hotFilter = { enabled: true, minLikes: 100 };
    await start(); emitCard(); await vi.advanceTimersByTimeAsync(0);
    mocks.change!({ ...mocks.settings, hotFilter: { enabled: true, minLikes: 1000 } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0);
    mocks.change!({ ...mocks.settings, hotFilter: { enabled: true, minLikes: 100 } });
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(1);
  });

  it("低赞卡片后来达标能采集，重复事件不重复排评论", async () => {
    mocks.settings.hotFilter = { enabled: true, minLikes: 1000 };
    await start(); emitCard(); await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0);
    emitCard({ ...card, likes: 1000 }); await vi.advanceTimersByTimeAsync(1600);
    emitCard({ ...card, likes: 1001 }); await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(1);
    expect(calls("DEEP_COLLECT")).toHaveLength(1);
  });

  it("已入库的评论补传保留原库且不受新门槛限制", async () => {
    mocks.settings.collectionId = 12;
    await start(); emitCard(); await vi.advanceTimersByTimeAsync(1600);
    mocks.change!({ ...mocks.settings, collectionId: 99, hotFilter: { enabled: true, minLikes: 1000 } });
    doc.dispatchEvent(new CustomEvent("v2m:notes", { detail: {
      source: "detail", items: [], details: [{ ...card, content: "正文", tags: [], images: [] }],
    } }));
    doc.dispatchEvent(new CustomEvent("v2m:comments", { detail: { noteId: card.noteId, comments: [{ commentId: "late", content: "补评论", userName: "test", likes: 0 }] } }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT").at(-1)![0].batch.collectionId).toBe(12);
    expect(calls("EXT_COLLECT").at(-1)![0].batch.details[0].commentsData).toHaveLength(1);
  });

  it("手动采集本篇绕过点赞门槛", async () => {
    mocks.settings.hotFilter = { enabled: true, minLikes: 1000 };
    mocks.cached = [card];
    mocks.cachedDetails = [{ ...card, content: "正文", tags: ["测试"], images: [{ url: "a" }, { url: "b" }] }];
    mocks.cachedComments = { [card.noteId]: [{ commentId: "manual", content: "评论", userName: "test", likes: 0 }] };
    vi.stubGlobal("location", new URL(card.url));
    await start();
    mocks.clicks.get("采集本篇")!();
    await vi.advanceTimersByTimeAsync(3200);
    expect(calls("EXT_COLLECT").length).toBeGreaterThan(0);
    expect(calls("EXT_COLLECT")[0]![0].batch.details[0].likes).toBe(100);
  });

  it("SSR 详情缺少签名令牌时，深度任务仍沿用卡片的签名 URL", async () => {
    await start();
    doc.dispatchEvent(new CustomEvent("v2m:notes", { detail: {
      source: "homefeed", items: [card], details: [{ ...card, url: `https://www.xiaohongshu.com/explore/${card.noteId}`, xsecToken: "", content: "正文", tags: [], images: [] }],
    } }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("DEEP_COLLECT")[0]![0].url).toBe(card.url);
  });

  it("自动入库成功后补评论，同一页重复事件只排一次深度任务", async () => {
    await start();
    emitCard();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(1);
    expect(calls("DEEP_COLLECT")).toHaveLength(1);
    emitCard();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("DEEP_COLLECT")).toHaveLength(1);
  });

  it("初始 SSR 缓存也走自动入库和深度采集", async () => {
    mocks.cached = [card];
    await start();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(1);
    expect(calls("DEEP_COLLECT")).toHaveLength(1);
  });

  it("读完设置前不按缺省开启状态上传", async () => {
    let resolveSettings!: (value: typeof mocks.settings) => void;
    mocks.getSettings.mockImplementation(() => new Promise(resolve => { resolveSettings = resolve; }));
    await start();
    emitCard();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0);
    resolveSettings({ ...mocks.settings, autoCollect: false });
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0);
  });

  it("关深度采集仍可自动入库，但不排评论任务", async () => {
    mocks.settings.deepCollect = false;
    await start(); emitCard();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(1);
    expect(calls("DEEP_COLLECT")).toHaveLength(0);
  });

  it("入库失败时不提前排深度任务", async () => {
    mocks.send.mockImplementation(async (msg) => {
      if (msg.type === "EXT_COLLECT") throw new Error("offline");
      return { queued: true };
    });
    await start(); emitCard();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("DEEP_COLLECT")).toHaveLength(0);
  });

  it("评论先于详情到达时，首次自动上报也带评论明细", async () => {
    await start();
    const comments = [{ commentId: "c1", userName: "测试", content: "测试评论", likes: 0 }];
    doc.dispatchEvent(new CustomEvent("v2m:comments", { detail: { noteId: card.noteId, comments } }));
    doc.dispatchEvent(new CustomEvent("v2m:notes", { detail: {
      source: "detail", items: [card], details: [{ ...card, content: "正文", tags: [], images: [] }],
    } }));
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")[0]![0].batch.details[0].commentsData).toEqual(comments);
    expect(calls("DEEP_COLLECT")).toHaveLength(0);
  });

  it("隐藏采集页不会把嗅探批次自动入库或再次排深度任务", async () => {
    vi.stubGlobal("location", new URL(`${card.url}&__v2m_collect=1&__v2m_auto=1`));
    await start(); emitCard();
    await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")).toHaveLength(0);
    expect(calls("DEEP_COLLECT")).toHaveLength(0);
  });

  it("document_idle 之前的评论缓存进入首次自动详情上报", async () => {
    mocks.cached = [card];
    mocks.cachedDetails = [{ ...card, content: "正文", tags: [], images: [] }];
    mocks.cachedComments = { [card.noteId]: [{ commentId: "early", userName: "测试", content: "早到评论", likes: 1 }] };
    await start(); await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")[0]![0].batch.details[0].commentsData[0].commentId).toBe("early");
  });

  it("直接打开详情只自动采当前篇，推荐卡片不被附带入库", async () => {
    vi.stubGlobal("location", new URL(card.url));
    mocks.settings.deepCollect = false;
    mocks.cached = [card, { ...card, noteId: "other" }];
    await start(); await vi.advanceTimersByTimeAsync(1600);
    expect(calls("EXT_COLLECT")[0]![0].batch.items.map((n: NoteCard) => n.noteId)).toEqual([card.noteId]);
  });

  it("当前已打开的详情自动补评论，直接读 MAIN 缓存而不开隐藏页", async () => {
    vi.stubGlobal("location", new URL(card.url));
    mocks.cached = [card];
    mocks.cachedDetails = [{ ...card, content: "正文", tags: [], images: [] }];
    await start();
    mocks.cachedComments = { [card.noteId]: [{ commentId: "late", userName: "测试", content: "补采评论", likes: 1 }] };
    await vi.advanceTimersByTimeAsync(3200);
    expect(calls("DEEP_COLLECT")).toHaveLength(0);
    expect(calls("EXT_COLLECT").at(-1)![0].batch.details[0].commentsData[0].commentId).toBe("late");
    const before = calls("EXT_COLLECT").length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(calls("EXT_COLLECT")).toHaveLength(before); // 不在上传成功后循环启动。
  });

  it("可见的评论容器即使 offsetParent 为空也会自动滚动翻页", async () => {
    vi.stubGlobal("location", new URL(card.url));
    mocks.cached = [card];
    const scrollBy = vi.fn();
    const fallbackScroll = vi.fn();
    const scroller = Object.assign(new EventTarget(), {
      offsetParent: null, scrollHeight: 3819, clientHeight: 412,
      getClientRects: () => [{ width: 399, height: 412 }], scrollBy,
    });
    Object.assign(doc, {
      querySelector: (selector: string) => selector === ".note-scroller" ? scroller : null,
      scrollingElement: { scrollBy: fallbackScroll, dispatchEvent: vi.fn() },
    });
    vi.stubGlobal("getComputedStyle", () => ({ overflowY: "scroll", visibility: "visible" }));
    vi.stubGlobal("WheelEvent", class extends Event {});
    mocks.main.mockImplementation(async (action) => action === "getNote"
      ? { card, comments: [], commentsHasMore: true }
      : { cards: mocks.cached, details: [], comments: {} });
    await start(); await vi.advanceTimersByTimeAsync(2800);
    expect(scrollBy).toHaveBeenCalled();
    expect(fallbackScroll).not.toHaveBeenCalled();
  });
});
