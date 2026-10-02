import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import type { CoverSpec, Draft } from "@v2media/shared";
import type { R2Storage } from "../src/lib/r2";
import { collectionAnalyses, drafts, jobs, mediaAssets } from "../src/db/schema";
import { runDraftJobs, startDraftWorker } from "../src/lib/draft-jobs";
import { runCoverJobs } from "../src/lib/cover-jobs";
import { authed, makeApp, registerUser } from "./helpers";

export function coverStorage() {
  const objects = new Map<string, { bytes: ArrayBuffer; type: string }>();
  const r2: R2Storage = {
    head: vi.fn(async key => objects.has(key)),
    put: vi.fn(async (key, bytes, type) => { objects.set(key, { bytes, type }); }),
    putStream: vi.fn(),
    get: vi.fn(async key => { const o = objects.get(key); return o ? new Response(o.bytes, { headers: { "content-type": o.type } }) : null; }),
    list: vi.fn(async p => [...objects].filter(([k]) => k.startsWith(p)).map(([key, o]) => ({ key, size: o.bytes.byteLength, lastModified: Date.now() }))),
    delete: vi.fn(async key => objects.delete(key)),
  };
  return { r2, objects };
}
const generated = () => JSON.stringify({
  title: "下班备餐不用赶", content: "先分好食材，再按顺序准备，最后分装留好标签。\n你通常什么时候准备饭？",
  tags: ["备餐"], cover: "备餐做这3步", coverPoints: ["先分好食材", "按顺序准备", "分装留好标签"],
});
async function fixture(complete = vi.fn(async () => generated())) {
  const ctx = await makeApp({ complete });
  const storage = coverStorage(); ctx.deps.r2 = storage.r2;
  const { token, userId } = await registerUser(ctx.app);
  const col = await (await ctx.app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "备餐" }) }))).json() as any;
  await ctx.app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({
    collectionId: col.id, items: [{ noteId: "source", title: "原作者封面", author: {}, cover: "https://example.test/original.png" }],
    details: [{ noteId: "source", title: "原作者封面", content: "真实要点", images: [{ url: "https://example.test/original.png" }], tags: ["备餐"] }],
  }) }));
  const notes = await (await ctx.app.request("/api/notes", authed(token))).json() as any;
  const sourceId = notes.items[0].id;
  await ctx.db.insert(collectionAnalyses).values({
    userId, collectionId: col.id, noteCount: 1, status: "done",
    data: { stats: {} as any, insight: null, visual: [{ ref: 1, id: sourceId, cover: "", kind: "清单步骤", text: "", hook: "", hit: true, engagement: 10 }] },
  });
  const topic = await (await ctx.app.request("/api/topics", authed(token, { method: "POST", body: JSON.stringify({ title: "备餐选题", angle: "下班后也不赶\n借步骤结构", sourceNoteId: sourceId, collectionId: col.id }) }))).json() as any;
  const create = () => ctx.app.request("/api/topics/" + topic.id + "/to-draft", authed(token, { method: "POST", body: JSON.stringify({ ai: true }) }));
  const get = async (id: number) => await (await ctx.app.request("/api/drafts/" + id, authed(token))).json() as Draft;
  const cover = (draft: Draft, spec: CoverSpec) => ctx.app.request("/api/drafts/" + draft.id + "/cover", authed(token, {
    method: "POST", body: JSON.stringify({ revision: draft.coverRevision, spec }),
  }));
  return { ...ctx, ...storage, token, userId, topic, create, get, cover, complete };
}

describe("一键成稿 → 自动封面（持久 jobs + mock AI/R2）", () => {
  it("202 不等 AI；并发点击只建一稿；文字/封面自动完成且可直接创建私密发布任务", async () => {
    const f = await fixture();
    const responses = await Promise.all([f.create(), f.create()]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 202]);
    const a = await responses[0]!.json() as any, b = await responses[1]!.json() as any;
    expect(a.draft.id).toBe(b.draft.id); expect(f.complete).not.toHaveBeenCalled();
    expect((await f.db.select().from(jobs).where(eq(jobs.type, "draft_generate")))).toHaveLength(1);
    // Server-only tasks cannot be picked up by the extension.
    const pending = await (await f.app.request("/api/ext/tasks/pending", authed(f.token))).json() as any;
    expect(pending.tasks.some((t: any) => ["draft_generate", "cover_generate"].includes(t.type))).toBe(false);
    await runDraftJobs(f.deps);
    let draft = await f.get(a.draft.id);
    expect(draft.generationState).toBe("done"); expect(draft.coverSpec!.templateId).toBe("checklist");
    expect(draft.images[0]!.url).toBe("");
    await runCoverJobs({ ...f.deps }); // New worker context uses only persisted state.
    draft = await f.get(draft.id);
    expect(draft.coverState).toBe("ready"); expect(draft.images[0]!.url).toContain("/objects/cover/");
    expect(draft.images.some(i => i.url.includes("original.png"))).toBe(false);
    const object = await f.app.request(new URL(draft.images[0]!.url).pathname);
    expect((await sharp(Buffer.from(await object.arrayBuffer())).metadata())).toMatchObject({ width: 1080, height: 1440, format: "png" });
    await f.app.request("/api/ext/accounts/heartbeat", authed(f.token, { method: "POST", body: JSON.stringify({
      accounts: [{ xhsUserId: "u1", nickname: "薯", subType: "creator", status: "online" }],
    }) }));
    const accounts = await (await f.app.request("/api/accounts", authed(f.token))).json() as any;
    expect((await f.app.request("/api/publish/jobs", authed(f.token, { method: "POST", body: JSON.stringify({
      draftId: draft.id, accountId: accounts[0].id, visibility: "private",
    }) }))).status).toBe(200);
  });

  it("手工改字不被迟到 AI 覆盖；失败可按当前文字版本重试", async () => {
    let release!: () => void;
    let started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const begin = new Promise<void>(resolve => { started = resolve; });
    const complete = vi.fn(async () => { started(); await wait; return generated(); });
    const f = await fixture(complete);
    const created = await (await f.create()).json() as any;
    const running = runDraftJobs(f.deps); await begin;
    await f.app.request("/api/drafts/" + created.draft.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ content: "用户手工写的正文" }) }));
    release(); await running;
    let draft = await f.get(created.draft.id);
    expect(draft.content).toBe("用户手工写的正文");
    expect(draft.generationState).toBe("failed"); expect(draft.generationError).toContain("已保留修改");
    expect((await f.db.select().from(jobs).where(eq(jobs.type, "cover_generate")))).toHaveLength(0);
    complete.mockImplementation(async () => generated());
    expect((await f.app.request("/api/drafts/" + draft.id + "/generate/retry", authed(f.token, { method: "POST" }))).status).toBe(202);
    await runDraftJobs(f.deps); await runCoverJobs(f.deps);
    draft = await f.get(draft.id);
    expect(draft.generationState).toBe("done"); expect(draft.coverState).toBe("ready");
  });

  it("重新生成只换封面、失败保留旧图；旧参数与跨用户请求拒绝", async () => {
    const f = await fixture();
    const created = await (await f.create()).json() as any;
    await runDraftJobs(f.deps); await runCoverJobs(f.deps);
    let draft = await f.get(created.draft.id);
    const original = draft.images[0]!;
    const userPhotos = [{ url: "https://example.test/own-1.png" }, { url: "https://example.test/own-2.png" }];
    await f.app.request("/api/drafts/" + draft.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ images: [...draft.images, ...userPhotos], imagesVersion: draft.imagesVersion }) }));
    draft = await f.get(draft.id);
    const spec: CoverSpec = { templateId: "poster", headline: "换一张新的封面" };
    expect((await f.cover(draft, spec)).status).toBe(202);
    expect((await f.cover(draft, spec)).status).toBe(409);
    vi.mocked(f.r2.put).mockRejectedValue(new Error("R2 offline"));
    let now = Date.now(); f.deps.now = () => new Date(now);
    for (let i = 0; i < 3; i++) { await runCoverJobs(f.deps); now += 180_000; }
    draft = await f.get(draft.id);
    expect(draft.coverState).toBe("failed"); expect(draft.images[0]).toEqual(original);
    expect(draft.images.slice(1)).toEqual(userPhotos);
    const { token: other } = await registerUser(f.app, "other@test.co");
    expect((await f.app.request("/api/drafts/" + draft.id + "/cover", authed(other, { method: "POST", body: JSON.stringify({ revision: draft.coverRevision, spec }) }))).status).toBe(404);
    vi.mocked(f.r2.put).mockImplementation(async (key, bytes, type) => { f.objects.set(key, { bytes, type }); });
    expect((await f.cover(draft, spec)).status).toBe(202);
    await runCoverJobs(f.deps);
    draft = await f.get(draft.id);
    expect(draft.coverState).toBe("ready"); expect(draft.images[0]!.url).not.toBe(original.url);
    expect(draft.images.slice(1)).toEqual(userPhotos);
  });

  it("移除生成中的封面后迟到结果不复活；新参数覆盖旧任务", async () => {
    const f = await fixture();
    const created = await (await f.create()).json() as any;
    await runDraftJobs(f.deps);
    let draft = await f.get(created.draft.id);
    let release!: () => void, started!: () => void;
    const wait = new Promise<void>(resolve => { release = resolve; }), begin = new Promise<void>(resolve => { started = resolve; });
    vi.mocked(f.r2.put).mockImplementationOnce(async (key, bytes, type) => { started(); await wait; f.objects.set(key, { bytes, type }); });
    const running = runCoverJobs(f.deps); await begin;
    await f.app.request("/api/drafts/" + draft.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ images: [], imagesVersion: draft.imagesVersion }) }));
    release(); await running;
    draft = await f.get(draft.id);
    expect(draft.images).toEqual([]); expect(draft.coverState).toBe("idle");
    expect((await f.cover(draft, { templateId: "poster", headline: "旧参数" })).status).toBe(202);
    draft = await f.get(draft.id);
    expect((await f.cover(draft, { templateId: "poster", headline: "新参数" })).status).toBe(202);
    await runCoverJobs(f.deps); await runCoverJobs(f.deps);
    draft = await f.get(draft.id);
    expect(draft.images).toHaveLength(1); expect(draft.coverSpec!.headline).toBe("新参数"); expect(draft.coverState).toBe("ready");
  });

  it("R2 缺失不创建半成品；AI 失败记录原因；遗留任务恢复", async () => {
    const f = await fixture();
    f.deps.r2 = null;
    expect((await f.create()).status).toBe(503);
    expect((await f.db.select().from(drafts))).toHaveLength(0);
    f.deps.r2 = f.r2;
    const created = await (await f.create()).json() as any;
    f.complete.mockRejectedValueOnce(new Error("gateway timeout"));
    await runDraftJobs(f.deps);
    expect((await f.get(created.draft.id)).generationError).toContain("timeout");
    await f.app.request("/api/drafts/" + created.draft.id + "/generate/retry", authed(f.token, { method: "POST" }));
    const [job] = await f.db.select().from(jobs).where(and(eq(jobs.type, "draft_generate"), eq(jobs.status, "queued")));
    await f.db.update(jobs).set({ status: "processing", claimedAt: new Date(Date.now() - 13 * 60_000) }).where(eq(jobs.id, job!.id));
    await runDraftJobs(f.deps); await runCoverJobs(f.deps);
    expect((await f.get(created.draft.id)).coverState).toBe("ready");
  });

  it("照片封面只读取自己的 ready 上传素材，参数缺失不入队", async () => {
    const f = await fixture();
    const created = await (await f.create()).json() as any;
    await runDraftJobs(f.deps); await runCoverJobs(f.deps);
    const draft = await f.get(created.draft.id);
    expect((await f.cover(draft, { templateId: "checklist", headline: "清单", points: ["只有一点"] })).status).toBe(400);
    expect((await f.cover(draft, { templateId: "photo", headline: "照片", backgroundAssetId: draft.coverAssetId! })).status).toBe(400);
    const bytes = await sharp({ create: { width: 80, height: 100, channels: 3, background: "green" } }).png().toBuffer();
    const key = "upload/" + "b".repeat(64);
    f.objects.set(key, { bytes: Uint8Array.from(bytes).buffer, type: "image/png" });
    const [photo] = await f.db.insert(mediaAssets).values({ userId: f.userId, draftId: draft.id, uploadId: crypto.randomUUID(), sourceFile: crypto.randomUUID(),
      sourceHash: "b".repeat(64), filename: "自己的照片.png", key, url: "http://localhost/api/media/objects/" + key, status: "ready", kind: "upload" }).returning();
    const { userId: other } = await registerUser(f.app, "photo-other@test.co");
    await f.db.update(mediaAssets).set({ userId: other }).where(eq(mediaAssets.id, photo!.id));
    expect((await f.cover(draft, { templateId: "photo", headline: "照片", backgroundAssetId: photo!.id })).status).toBe(400);
    await f.db.update(mediaAssets).set({ userId: f.userId }).where(eq(mediaAssets.id, photo!.id));
    expect((await f.cover(draft, { templateId: "photo", headline: "照片", backgroundAssetId: photo!.id })).status).toBe(202);
    await runCoverJobs(f.deps);
    expect((await f.get(draft.id)).coverState).toBe("ready");
    expect(f.r2.get).toHaveBeenCalledWith(key);
  });

  it("慢 AI 正在写稿时，另一篇的模板封面仍能完成", async () => {
    let release!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; });
    const complete = vi.fn(async () => { await hold; return generated(); });
    const f = await fixture(complete);
    await f.create();
    const manual = await (await f.app.request("/api/drafts", authed(f.token, { method: "POST", body: JSON.stringify({ title: "手写稿" }) }))).json() as Draft;
    expect((await f.cover(manual, { templateId: "poster", headline: "手写稿的封面" })).status).toBe(202);
    const timer = startDraftWorker(f.deps);
    try {
      let rendered = await f.get(manual.id);
      for (let i = 0; i < 80 && rendered.coverState !== "ready"; i++) {
        await new Promise(resolve => setTimeout(resolve, 25)); rendered = await f.get(manual.id);
      }
      expect(complete).toHaveBeenCalledTimes(1);
      expect(rendered.coverState).toBe("ready");
      const [writing] = await f.db.select().from(drafts).where(eq(drafts.generationState, "writing"));
      expect(writing).toBeTruthy();
    } finally { clearInterval(timer); release(); }
  });
});
