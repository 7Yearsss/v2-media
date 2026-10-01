import { afterEach, expect, it, vi } from "vitest";
import { runMediaJobs } from "../src/lib/media-jobs";
import type { R2Storage } from "../src/lib/r2";
import { authed, makeApp, registerUser } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

function storage() {
  const objects = new Map<string, number>();
  const r2 = {
    head: vi.fn(async (key: string) => objects.has(key)),
    put: vi.fn(async (key: string, bytes: ArrayBuffer) => { objects.set(key, bytes.byteLength); }),
    // 和真实上传一致：必须把流读完再返回（临时文件在调用返回后会被删，不读完会在 Linux 上抛未处理的 ENOENT）
    putStream: vi.fn(async (key: string, body: AsyncIterable<unknown>, _type: string, length: number) => {
      for await (const _chunk of body) { /* drain */ }
      objects.set(key, length);
    }),
    list: vi.fn(async () => []),
    delete: vi.fn(async () => true),
  } as unknown as R2Storage;
  return { r2, objects };
}

const video = (over: Record<string, unknown> = {}) => ({
  durationMs: 9384, width: 720, height: 1280, fps: 60, size: 5_000_000, format: "mp4", videoCodec: "h264", ...over,
});

async function collect(app: Awaited<ReturnType<typeof makeApp>>["app"], token: string, extra: Record<string, unknown>) {
  const res = await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({
    source: "detail",
    items: [{ noteId: "vid", type: "video", title: "视频笔记" }],
    details: [{ noteId: "vid", type: "video", title: "视频笔记", content: "正文", ...extra }],
  }) }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { ids: number[] }).ids[0]!;
}

it("视频时长/分辨率等元信息随详情入库，卡片批次重传不抹掉", async () => {
  const { app } = await makeApp();
  const { token } = await registerUser(app);
  const id = await collect(app, token, { videoUrl: "https://sns-video.xhscdn.com/a.mp4", video: video() });
  const note = await (await app.request(`/api/notes/${id}`, authed(token))).json() as any;
  expect(note.videoUrl).toBe("https://sns-video.xhscdn.com/a.mp4");
  expect(note.video).toMatchObject({ durationMs: 9384, height: 1280, size: 5_000_000 });
  // 只有卡片（没有 details）的批次不应清掉已有的视频信息
  await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({
    source: "search", items: [{ noteId: "vid", type: "video", title: "视频笔记" }],
  }) }));
  const again = await (await app.request(`/api/notes/${id}`, authed(token))).json() as any;
  expect(again.videoUrl).toBe("https://sns-video.xhscdn.com/a.mp4");
  expect(again.video?.durationMs).toBe(9384);
});

it("视频转存到 R2；主流超过大小上限时退到更小的清晰度，都超限则保留原链", async () => {
  const { app, deps } = await makeApp();
  const { r2, objects } = storage(); deps.r2 = r2;
  const { token } = await registerUser(app);
  const big = "https://sns-video.xhscdn.com/big.mp4", small = "https://sns-video.xhscdn.com/small.mp4";
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    // free 档上限 80MB：big 声明 200MB 直接放弃，small 是 1KB
    if (url === big) return new Response(null, { status: 200, headers: { "content-length": String(200_000_000) } });
    return new Response(new Uint8Array(1024), { headers: { "content-type": "video/mp4" } });
  });
  vi.stubGlobal("fetch", fetcher);
  const id = await collect(app, token, { videoUrl: big, video: video({ fallbackUrls: [small] }) });
  await runMediaJobs(deps);
  const note = await (await app.request(`/api/notes/${id}`, authed(token))).json() as any;
  expect(note.videoUrl).toContain("/api/media/objects/vid/");
  expect([...objects.entries()].filter(([k]) => k.startsWith("vid/"))).toEqual([[expect.stringMatching(/^vid\//), 1024]]);
  expect(fetcher.mock.calls.map(([u]) => String(u))).toEqual(expect.arrayContaining([big, small]));

  // 没有更小的可退：保留原链、不写 R2
  const objectsBefore = objects.size;
  const id2 = await (async () => {
    const res = await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({
      source: "detail", items: [{ noteId: "vid2", type: "video", title: "另一个" }],
      details: [{ noteId: "vid2", type: "video", title: "另一个", videoUrl: big }],
    }) }));
    return ((await res.json()) as { ids: number[] }).ids[0]!;
  })();
  await runMediaJobs(deps);
  const kept = await (await app.request(`/api/notes/${id2}`, authed(token))).json() as any;
  expect(kept.videoUrl).toBe(big);
  expect(objects.size).toBe(objectsBefore);
});
