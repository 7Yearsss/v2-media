import { describe, expect, it } from "vitest";
import { normalizeXhsMediaUrl, noteCardFromItem, noteCardsFromResponse, noteDetailFromFeedResponse, xhsInitialStateFromHtml } from "@v2media/shared/xhs-parse";

describe("详情图片解析", () => {
  it("SSR 空 Map/Set 和裸 undefined 不阻断详情补采，正文字符串不被改写", () => {
    expect(xhsInitialStateFromHtml('<script>window.__INITIAL_STATE__={"note":{"noteDetailMap":new Map([])},"items":new Set([]),"missing":undefined,"desc":"new Map([]) :undefined, \\\"quoted\\\""};</script>'))
      .toEqual({ note: { noteDetailMap: {} }, items: [], missing: null, desc: 'new Map([]) :undefined, "quoted"' });
    expect(xhsInitialStateFromHtml('<script>window.__INITIAL_STATE__=alert("no execution");</script>')).toBeNull();
  });
  it("SSR 列表 camelCase 标题封面与令牌完整解析，不被空 url 覆盖", () => {
    const card = noteCardFromItem({ id: "camel-card", xsecToken: "test-token", noteCard: {
      displayTitle: "列表标题", type: "normal", user: { userId: "author", nickName: "作者" },
      cover: { url: "", urlDefault: "http://sns-webpic-qc.xhscdn.com/cover" },
      interactInfo: { likedCount: 42 },
    } }, "homefeed");
    expect(card).toMatchObject({ title: "列表标题", cover: "https://sns-webpic-qc.xhscdn.com/cover", xsecToken: "test-token", likes: 42, author: { nickname: "作者" } });
    expect(card?.url).toContain("xsec_token=test-token");
  });
  it("缺省封面为空时使用 infoList，排除 camelCase 非笔记条目", () => {
    const item = { id: "cover-info", modelType: "note", noteCard: {
      cover: { url_default: "", urlDefault: "", infoList: [{ url: "https://sns-webpic-qc.xhscdn.com/info" }] },
    } };
    expect(noteCardFromItem(item, "search")?.cover).toBe("https://sns-webpic-qc.xhscdn.com/info");
    expect(noteCardsFromResponse({ data: { items: [{ ...item, modelType: "user" }, item] } }, "search").items).toHaveLength(1);
  });
  it("HTTP 小红书图片升级 HTTPS，保留其他域与原有查询参数", () => {
    const url = "http://sns-webpic-qc.xhscdn.com/image?a=1&b=2";
    expect(normalizeXhsMediaUrl(url)).toBe("https://sns-webpic-qc.xhscdn.com/image?a=1&b=2");
    expect(normalizeXhsMediaUrl("http://xhscdn.com.evil.test/image")).toBe("http://xhscdn.com.evil.test/image");
    const detail = noteDetailFromFeedResponse({ data: { items: [{ note_card: {
      note_id: "http-images", image_list: [{ url_default: url }],
    } }] } });
    expect(detail?.images[0]?.url).toBe(normalizeXhsMediaUrl(url));
    expect(detail?.cover).toBe(normalizeXhsMediaUrl(url));
  });
  it("兼容 SSR 图片的 camelCase 字段和空默认地址", () => {
    const detail = noteDetailFromFeedResponse({ data: { items: [{ note_card: {
      note_id: "image-aliases",
      image_list: [
        { urlDefault: "https://cdn/one.jpg" },
        { url_default: "", infoList: [{ url: "https://cdn/two.jpg" }] },
        { url_default: "", info_list: [{ url: "https://cdn/three.jpg" }] },
      ],
    } }] } });
    expect(detail?.images.map(image => image.url)).toEqual([
      "https://cdn/one.jpg", "https://cdn/two.jpg", "https://cdn/three.jpg",
    ]);
  });
});
