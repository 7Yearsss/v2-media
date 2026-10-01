import { describe, expect, it } from "vitest";
import { normalizeXhsMediaUrl, noteCardFromItem, pickVideo, noteCardsFromResponse, noteDetailFromFeedResponse, xhsInitialStateFromHtml } from "@v2media/shared/xhs-parse";

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

describe("视频流解析", () => {
  const stream = (over: Record<string, unknown>) => ({
    masterUrl: "http://sns-video.xhscdn.com/base.mp4", width: 720, height: 1280, size: 2_000_000,
    fps: 30, format: "mp4", videoCodec: "h264", avgBitrate: 1_800_000, qualityType: "HD", duration: 9384, ...over,
  });
  it("页面 store 的 camelCase + 非 h264 分组键（EF4）也能取到视频地址并升级 https", () => {
    const { url, info } = pickVideo({ media: { videoId: 7, video: { duration: 10 }, stream: { EF4: [stream({})] } } });
    expect(url).toBe("https://sns-video.xhscdn.com/base.mp4");
    expect(info).toMatchObject({ durationMs: 9384, width: 720, height: 1280, fps: 30, size: 2_000_000, format: "mp4", videoCodec: "h264", bitrate: 1_800_000, quality: "HD", videoId: "7" });
  });
  it("接口 snake_case 同样可用，且 detail 解析带上 video 元信息", () => {
    const detail = noteDetailFromFeedResponse({ data: { items: [{ id: "v1", note_card: {
      note_id: "v1", type: "video", title: "t",
      video: { media: { stream: { h264: [{ master_url: "http://sns-video.xhscdn.com/a.mp4", height: 720, size: 5 }] } } },
    } }] } });
    expect(detail?.videoUrl).toBe("https://sns-video.xhscdn.com/a.mp4");
    expect(detail?.video?.height).toBe(720);
  });
  it("优先 1080p 以内最高清，同清晰度优先 h264，更小的清晰度进 fallbackUrls（由大到小）", () => {
    const { url, info } = pickVideo({ media: { stream: {
      A: [stream({ masterUrl: "https://c/4k.mp4", height: 2160, size: 90_000_000 })],
      B: [stream({ masterUrl: "https://c/1080-h265.mp4", height: 1080, size: 6_000_000, videoCodec: "h265" })],
      C: [stream({ masterUrl: "https://c/1080-h264.mp4", height: 1080, size: 8_000_000 })],
      D: [stream({ masterUrl: "https://c/480.mp4", height: 480, size: 1_000_000 })],
    } } });
    expect(url).toBe("https://c/1080-h264.mp4");
    expect(info?.fallbackUrls).toEqual(["https://c/1080-h265.mp4", "https://c/480.mp4"]);
  });
  it("全部流都超过 1080p 时取其中最低的；没有 stream 时退回 originVideoKey，无视频返回空", () => {
    expect(pickVideo({ media: { stream: { A: [stream({ masterUrl: "https://c/4k.mp4", height: 2160 }), stream({ masterUrl: "https://c/1440.mp4", height: 1440 })] } } }).url)
      .toBe("https://c/1440.mp4");
    expect(pickVideo({ consumer: { originVideoKey: "abc" } }).url).toBe("https://sns-video-qc.xhscdn.com/abc");
    expect(pickVideo(undefined)).toEqual({});
  });
});
