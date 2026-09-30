import { afterEach, expect, it, vi } from "vitest";
import sharp from "sharp";
import { commentsFromResponse, noteCardFromItem } from "@v2media/shared/xhs-parse";
import { mergeComments } from "@v2media/shared";
import { storeAvatar, pruneMedia } from "../src/lib/media-store";
import { runMediaJobs } from "../src/lib/media-jobs";
import type { R2Storage } from "../src/lib/r2";
import { authed, makeApp, registerUser } from "./helpers";

afterEach(() => vi.unstubAllGlobals());
const source = "https://sns-avatar.xhscdn.com/avatar.jpg";
function storage() {
  const objects = new Map<string, ArrayBuffer>();
  const r2 = {
    head: vi.fn(async (key: string) => objects.has(key)),
    put: vi.fn(async (key: string, bytes: ArrayBuffer) => { objects.set(key, bytes); }),
    list: vi.fn(async (prefix: string) => [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, bytes]) => ({ key, size: bytes.byteLength, lastModified: Date.now() - 3600_000 }))),
    delete: vi.fn(async (key: string) => objects.delete(key)),
  } as unknown as R2Storage;
  return { r2, objects };
}

it("解析作者、主评论和回复头像，并保留未再次返回的头像", () => {
  expect(noteCardFromItem({ id: "n", note_card: { user: { avatar: source.replace("https:", "http:") } } }, "homefeed")?.author.avatar).toBe(source);
  const parsed = commentsFromResponse({ data: { comments: [{ id: "c", user_info: { image: source }, sub_comments: [{ id: "r", user_info: { user_id: "u", image: source } }] }] } });
  expect(parsed[0]).toMatchObject({ avatar: source, subComments: [{ userId: "u", avatar: source }] });
  expect(mergeComments(parsed, [{ ...parsed[0]!, avatar: "" }])[0]?.avatar).toBe(source);
});

it("重复头像只上传一次，输出96px WebP，失败保留原链", async () => {
  const { r2, objects } = storage();
  const bytes = await sharp({ create: { width: 256, height: 192, channels: 3, background: "red" } }).png().toBuffer();
  const fetcher = vi.fn(async () => new Response(bytes, { headers: { "Content-Type": "image/png" } }));
  vi.stubGlobal("fetch", fetcher);
  const urls = await Promise.all(Array.from({ length: 10 }, () => storeAvatar(r2, source, "https://local.test")));
  expect(new Set(urls).size).toBe(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(r2.put).toHaveBeenCalledTimes(1);
  expect(await sharp(Buffer.from([...objects.values()][0]!)).metadata()).toMatchObject({ width: 96, height: 96, format: "webp" });
  fetcher.mockImplementation(async () => new Response(null, { status: 403 }));
  expect(await storeAvatar(r2, `${source}?fail`, "https://local.test")).toBe(`${source}?fail`);
  expect(await storeAvatar(r2, "https://untrusted.test/a", "https://local.test")).toBe("https://untrusted.test/a");
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("多个不同头像同时请求时最多下载两个，超限响应不会上传", async () => {
  const { r2 } = storage();
  const bytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: "green" } }).png().toBuffer();
  let active = 0, maximum = 0;
  vi.stubGlobal("fetch", vi.fn(async () => {
    active++; maximum = Math.max(maximum, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--; return new Response(bytes);
  }));
  await Promise.all(Array.from({ length: 8 }, (_, i) => storeAvatar(r2, `${source}?user=${i}`, "https://local.test")));
  expect(maximum).toBe(2);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1))));
  expect(await storeAvatar(r2, `${source}?oversize`, "https://local.test")).toBe(`${source}?oversize`);
  expect(r2.put).toHaveBeenCalledTimes(8);
});

it("采集先排队，后台回写三种头像，GC保留头像引用", async () => {
  const { app, deps } = await makeApp();
  const { r2 } = storage(); deps.r2 = r2;
  const { token } = await registerUser(app);
  const bytes = await sharp({ create: { width: 128, height: 128, channels: 3, background: "blue" } }).png().toBuffer();
  const fetcher = vi.fn(async () => new Response(bytes)); vi.stubGlobal("fetch", fetcher);
  const response = await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ source: "detail", items: [{ noteId: "avatars", author: { nickname: "作者", avatar: source } }], details: [{ noteId: "avatars", author: { nickname: "作者", avatar: source }, commentsData: [{ commentId: "c", nickname: "评论者", avatar: source, subComments: [{ commentId: "r", userName: "回复者", content: "回复", avatar: source }] }] }] }) }));
  expect(response.status).toBe(200);
  const { ids } = await response.json() as { ids: number[] };
  expect(fetcher).not.toHaveBeenCalled();
  await runMediaJobs(deps);
  const note = await (await app.request(`/api/notes/${ids[0]}`, authed(token))).json() as any;
  expect(note.authorAvatar).toContain("/api/media/objects/avatar/");
  expect(note.commentsData[0].avatar).toBe(note.authorAvatar);
  expect(note.commentsData[0].subComments[0].avatar).toBe(note.authorAvatar);
  expect(fetcher).toHaveBeenCalledTimes(1);
  await pruneMedia(deps);
  expect(r2.delete).not.toHaveBeenCalled();
});
