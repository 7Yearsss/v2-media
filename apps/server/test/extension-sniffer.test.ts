/// <reference types="chrome" />
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const payload = (id: string) => ({ success: true, data: { comments: [{
  id, content: `评论 ${id}`, like_count: "2", user_info: { nickname: "测试" },
}] } });
const url = "https://edith.xiaohongshu.com/api/sns/web/v2/comment/page?note_id=sample";

class TestXHR extends EventTarget {
  readyState = 0;
  responseURL = url;
  responseType = "";
  response: unknown;
  get responseText() {
    if (this.responseType === "json") throw new Error("InvalidStateError");
    return this.response as string;
  }
  open(_method: string, target: string) { this.responseURL = target; }
  send() { this.readyState = 4; this.dispatchEvent(new Event("readystatechange")); }
}

describe("真实嗅探脚本的评论响应通路", () => {
  let events: Array<{ noteId: string; comments: Array<{ commentId: string }> }>;
  beforeEach(() => {
    vi.resetModules(); vi.useFakeTimers(); events = [];
    const doc = new EventTarget();
    doc.addEventListener("v2m:comments", ev => events.push((ev as CustomEvent).detail));
    vi.stubGlobal("document", doc);
    vi.stubGlobal("window", new EventTarget());
    vi.stubGlobal("location", new URL("https://www.xiaohongshu.com/explore/sample"));
    vi.stubGlobal("history", { pushState() {}, replaceState() {} });
    // 每个测试独立类，避免脚本 hook 在共享 prototype 上叠加。
    vi.stubGlobal("XMLHttpRequest", class extends TestXHR {});
  });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
  async function start() { await import("../../extension/src/main-world/xhs"); }
  function respond(data: unknown, json = false) {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", url);
    Object.assign(xhr, { responseType: json ? "json" : "", response: json ? data : JSON.stringify(data) });
    xhr.send();
  }

  it("XHR responseType=json 时仍能捕获评论", async () => {
    await start(); respond(payload("c1"), true);
    expect(events[0]?.comments.map(c => c.commentId)).toEqual(["c1"]);
  });
  it("评论翻页累积而不覆盖前一页，重复响应按 id 去重", async () => {
    await start(); respond(payload("c1")); respond(payload("c2")); respond(payload("c1"));
    expect(events.at(-1)?.comments.map(c => c.commentId)).toEqual(["c1", "c2"]);
  });
  it("文本响应含空白前缀也能捕获评论", async () => {
    await start();
    const xhr = new XMLHttpRequest(); xhr.open("GET", url);
    Object.assign(xhr, { response: `\n ${JSON.stringify(payload("c1"))}` }); xhr.send();
    expect(events[0]?.comments.map(c => c.commentId)).toEqual(["c1"]);
  });
});
