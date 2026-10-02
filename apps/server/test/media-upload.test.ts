import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { Draft, MediaUploadResponse } from "@v2media/shared";
import type { R2Storage } from "../src/lib/r2";
import { jobs, mediaAssets } from "../src/db/schema";
import { runUploadJobs } from "../src/lib/upload-jobs";
import { pruneMedia } from "../src/lib/media-store";
import { env } from "../src/env";
import { authed, makeApp, registerUser } from "./helpers";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    if (!resolve(directory).startsWith(resolve(tmpdir()) + "\\") && !resolve(directory).startsWith(resolve(tmpdir()) + "/")) throw new Error("unsafe test directory");
    await rm(directory, { recursive: true, force: true });
  }
});

function storage() {
  const objects = new Map<string, { bytes: ArrayBuffer; type: string }>();
  const r2: R2Storage = {
    head: vi.fn(async key => objects.has(key)),
    put: vi.fn(async (key, bytes, type) => { objects.set(key, { bytes, type }); }),
    putStream: vi.fn(),
    get: vi.fn(async key => { const o = objects.get(key); return o ? new Response(o.bytes, { headers: { "content-type": o.type } }) : null; }),
    list: vi.fn(async prefix => [...objects].filter(([key]) => key.startsWith(prefix))
      .map(([key, o]) => ({ key, size: o.bytes.byteLength, lastModified: Date.now() - 3600_000 }))),
    delete: vi.fn(async key => objects.delete(key)),
  };
  return { r2, objects };
}
async function fixture() {
  const ctx = await makeApp();
  const { r2, objects } = storage();
  ctx.deps.r2 = r2;
  ctx.deps.uploadDir = await mkdtemp(join(tmpdir(), "v2media-upload-"));
  directories.push(ctx.deps.uploadDir);
  const { token } = await registerUser(ctx.app);
  const draft = await (await ctx.app.request("/api/drafts", authed(token, {
    method: "POST", body: JSON.stringify({ title: "我的图片" }),
  }))).json() as Draft;
  const png = await sharp({ create: { width: 32, height: 24, channels: 3, background: "red" } }).png().toBuffer();
  const upload = (d = draft, bytes = png, id = randomUUID(), auth = token) => {
    const form = new FormData();
    form.set("draftId", String(d.id)); form.set("imagesVersion", String(d.imagesVersion));
    form.set("uploadId", id); form.set("file", new File([Uint8Array.from(bytes)], "photo.png", { type: "image/png" }));
    return ctx.app.request("/api/media/upload", { method: "POST", headers: { Authorization: "Bearer " + auth }, body: form });
  };
  const get = async () => await (await ctx.app.request("/api/drafts/" + draft.id, authed(token))).json() as Draft;
  const patch = (body: unknown) => ctx.app.request("/api/drafts/" + draft.id, authed(token, { method: "PATCH", body: JSON.stringify(body) }));
  return { ...ctx, token, r2, objects, draft, upload, get, patch, png };
}

describe("草稿图片上传（内存 PGlite + mock R2，无外网）", () => {
  it("队列持久恢复、乱序处理保留选择顺序；发布冻结图集，GC 保留快照", async () => {
    const f = await fixture();
    let current = f.draft;
    const ids: number[] = [];
    for (let i = 0; i < 3; i++) {
      const response = await f.upload(current);
      expect(response.status).toBe(202);
      const result = await response.json() as MediaUploadResponse;
      expect(result.asset).not.toHaveProperty("sourceFile");
      ids.push(result.asset.id); current = result.draft;
    }
    expect(f.r2.put).not.toHaveBeenCalled();
    expect(await readdir(f.deps.uploadDir!)).toHaveLength(3);
    let now = Date.now();
    f.deps.now = () => new Date(now);
    const queued = await f.db.select().from(jobs).where(eq(jobs.type, "media_upload"));
    // Delay the first two so the third completes first.
    for (const job of queued.slice(0, 2)) await f.db.update(jobs).set({ dueAt: new Date(now + 60_000) }).where(eq(jobs.id, job.id));
    await f.db.update(jobs).set({ status: "processing", claimedAt: new Date(now - 21 * 60_000) }).where(eq(jobs.id, queued[2]!.id));
    await f.db.update(mediaAssets).set({ status: "processing" }).where(eq(mediaAssets.id, ids[2]!));
    await runUploadJobs({ ...f.deps }); // Fresh deps instance simulates worker restart.
    expect((await f.get()).images.map(i => i.assetId)).toEqual(ids);
    now += 120_000;
    await runUploadJobs(f.deps); await runUploadJobs(f.deps);
    current = await f.get();
    expect(current.uploads!.map(a => a.status)).toEqual(["ready", "ready", "ready"]);
    expect(current.images.map(i => i.assetId)).toEqual(ids);
    expect(await readdir(f.deps.uploadDir!)).toHaveLength(0);
    const object = await f.app.request(new URL(current.images[0]!.url).pathname);
    expect(object.status).toBe(200); expect(object.headers.get("content-type")).toBe("image/png");
    expect((await sharp(Buffer.from(await object.arrayBuffer())).metadata()).width).toBe(32);
    // All three source files are identical and deduplicated.
    expect(f.r2.put).toHaveBeenCalledTimes(1);
    await f.app.request("/api/ext/accounts/heartbeat", authed(f.token, { method: "POST", body: JSON.stringify({
      accounts: [{ xhsUserId: "u1", nickname: "薯", subType: "creator", status: "online" }],
    }) }));
    const accounts = await (await f.app.request("/api/accounts", authed(f.token))).json() as any[];
    const jobResponse = await f.app.request("/api/publish/jobs", authed(f.token, { method: "POST", body: JSON.stringify({
      draftId: current.id, accountId: accounts[0].id, visibility: "private",
    }) }));
    expect(jobResponse.status).toBe(200);
    const published = await jobResponse.json() as any;
    expect((await f.patch({ textVersion: current.textVersion, title: "后来改的标题", images: [], imagesVersion: current.imagesVersion })).status).toBe(200);
    const payload = await (await f.app.request("/api/ext/publish/" + published.id, authed(f.token))).json() as any;
    expect(payload.draft.title).toBe("我的图片"); expect(payload.draft.images.map((i: any) => i.assetId)).toEqual(ids);
    const originalCap = env.r2MaxBytes; env.r2MaxBytes = 1;
    try { await pruneMedia(f.deps); } finally { env.r2MaxBytes = originalCap; }
    expect(f.r2.delete).not.toHaveBeenCalled();
  });

  it("跨用户拒绝、鉴权、无 R2、坏图片/超限、重复提交不重复预留位置", async () => {
    const f = await fixture();
    expect((await f.upload(f.draft, f.png, randomUUID(), "")).status).toBe(401);
    const { token: other } = await registerUser(f.app, "other@test.co");
    expect((await f.upload(f.draft, f.png, randomUUID(), other)).status).toBe(404);
    f.deps.r2 = null;
    expect((await f.upload()).status).toBe(503); f.deps.r2 = f.r2;
    expect((await f.upload(f.draft, Buffer.from("<svg/>"))).status).toBe(415);
    expect((await f.upload(f.draft, Buffer.alloc(10 * 1024 * 1024 + 1))).status).toBe(413);
    const uploadId = randomUUID();
    const a = await (await f.upload(f.draft, f.png, uploadId)).json() as MediaUploadResponse;
    const b = await (await f.upload(f.draft, f.png, uploadId)).json() as MediaUploadResponse;
    expect(b.asset.id).toBe(a.asset.id); expect((await f.get()).images).toHaveLength(1);
    expect((await f.app.request("/api/media/assets/" + a.asset.id, authed(other))).status).toBe(404);
    expect((await f.upload(f.draft, f.png)).status).toBe(409);
    expect((await f.patch({ images: [], imagesVersion: 0 })).status).toBe(409);
    expect((await f.patch({ images: [] })).status).toBe(428);
    expect((await f.patch({ textVersion: (await f.get()).textVersion, title: "编辑文字" })).status).toBe(200);
    expect((await f.get()).images[0]!.assetId).toBe(a.asset.id);
  });

  it("移除处理中的图片后迟到任务不复活；其他草稿不受影响", async () => {
    const f = await fixture();
    const accepted = await (await f.upload()).json() as MediaUploadResponse;
    let release!: () => void;
    let started!: () => void;
    const begin = new Promise<void>(resolve => { started = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.r2.put).mockImplementationOnce(async (key, bytes, type) => {
      started(); await wait; f.objects.set(key, { bytes, type });
    });
    const running = runUploadJobs(f.deps);
    await begin;
    expect((await f.patch({ images: [], imagesVersion: accepted.draft.imagesVersion })).status).toBe(200);
    release(); await running;
    expect((await f.get()).images).toEqual([]);
    const [asset] = await f.db.select().from(mediaAssets).where(eq(mediaAssets.id, accepted.asset.id));
    expect(asset?.status).toBe("canceled");
    expect((await f.app.request("/api/media/assets/" + asset!.id + "/retry", authed(f.token, { method: "POST" }))).status).toBe(409);
    await pruneMedia(f.deps);
    expect(f.r2.delete).toHaveBeenCalledTimes(1);
  });

  it("失败自动退避三次；刷新可见失败并手动重试", async () => {
    const f = await fixture();
    const accepted = await (await f.upload()).json() as MediaUploadResponse;
    vi.mocked(f.r2.put).mockRejectedValue(new Error("R2 offline"));
    let now = Date.now(); f.deps.now = () => new Date(now);
    for (let i = 0; i < 3; i++) { await runUploadJobs(f.deps); now += 180_000; }
    expect((await f.get()).uploads![0]!.status).toBe("failed");
    expect(await readdir(f.deps.uploadDir!)).toHaveLength(1);
    const retry = await f.app.request("/api/media/assets/" + accepted.asset.id + "/retry", authed(f.token, { method: "POST" }));
    expect(retry.status).toBe(202);
    vi.mocked(f.r2.put).mockImplementation(async (key, bytes, type) => { f.objects.set(key, { bytes, type }); });
    await runUploadJobs(f.deps);
    expect((await f.get()).uploads![0]!.status).toBe("ready");
    expect((await f.db.select().from(jobs).where(and(eq(jobs.type, "media_upload"), eq(jobs.status, "queued"))))).toHaveLength(0);
  });

  it("按真实格式解码、校正 EXIF 方向并去元数据", async () => {
    const f = await fixture();
    const jpeg = await sharp({ create: { width: 12, height: 24, channels: 3, background: "blue" } })
      .jpeg().withMetadata({ orientation: 6 }).toBuffer();
    // Deliberately declares PNG: server must trust the image data, not the supplied MIME.
    expect((await f.upload(f.draft, jpeg)).status).toBe(202);
    await runUploadJobs(f.deps);
    const current = await f.get();
    expect(current.uploads![0]).toMatchObject({ status: "ready", width: 24, height: 12 });
    const object = await f.app.request(new URL(current.images[0]!.url).pathname);
    expect(object.headers.get("content-type")).toBe("image/jpeg");
    const metadata = await sharp(Buffer.from(await object.arrayBuffer())).metadata();
    expect(metadata.orientation).toBeUndefined(); expect(metadata.exif).toBeUndefined();
  });

  it("容量不足不删除现存图片或写入新对象，图集上限拒绝新预留", async () => {
    const f = await fixture();
    const full = await f.patch({ images: Array.from({ length: 9 }, (_, i) => ({ url: "https://example.test/" + i + ".png" })), imagesVersion: 0 });
    const fullDraft = await full.json() as Draft;
    expect((await f.upload(fullDraft)).status).toBe(400);
    const empty = await (await f.patch({ images: [], imagesVersion: fullDraft.imagesVersion })).json() as Draft;
    expect((await f.upload(empty)).status).toBe(202);
    const cap = env.r2MaxBytes; env.r2MaxBytes = 1;
    try { await runUploadJobs(f.deps); } finally { env.r2MaxBytes = cap; }
    expect(f.r2.put).not.toHaveBeenCalled(); expect(f.r2.delete).not.toHaveBeenCalled();
    expect((await f.get()).uploads![0]!.error).toContain("容量不足");
  });
});
