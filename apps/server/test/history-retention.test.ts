import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import type { R2Storage } from "../src/lib/r2";
import { accountSnapshots, drafts, hostedAccounts, jobs, mediaAssets, noteMetrics, postmortemReports, publishJobs, topics } from "../src/db/schema";
import { postmortemEvidence } from "../src/lib/insights-data";
import { runDraftJobs } from "../src/lib/draft-jobs";
import { runCoverJobs } from "../src/lib/cover-jobs";
import { runUploadJobs } from "../src/lib/upload-jobs";
import { pruneMedia } from "../src/lib/media-store";
import { authed, claimBrowser, makeApp, registerUser } from "./helpers";

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
    put: vi.fn(async (key, bytes, type) => { objects.set(key, { bytes, type }); }), putStream: vi.fn(),
    get: vi.fn(async key => { const o = objects.get(key); return o ? new Response(o.bytes, { headers: { "content-type": o.type } }) : null; }),
    list: vi.fn(async prefix => [...objects].filter(([key]) => key.startsWith(prefix)).map(([key, o]) => ({ key, size: o.bytes.byteLength, lastModified: Date.now() - 86400_000 }))),
    delete: vi.fn(async key => objects.delete(key)),
  };
  return { r2, objects };
}
async function fixture(complete = vi.fn(async () => JSON.stringify({ title: "新标题", content: "新正文", tags: [], cover: "新封面" }))) {
  const f = await makeApp({ complete });
  const { token, userId } = await registerUser(f.app);
  const [account] = await f.db.insert(hostedAccounts).values({ userId, xhsUserId: "history-owner", nickname: "原账号", status: "online", lastSeenAt: new Date() }).returning();
  const [draft] = await f.db.insert(drafts).values({ userId, accountId: account!.id, title: "发布时标题", content: "原正文", images: [{ url: "https://example.test/photo.png" }] }).returning();
  const createJob = async () => await (await f.app.request("/api/publish/jobs", authed(token, { method: "POST", body: JSON.stringify({ draftId: draft!.id, accountId: account!.id }) }))).json() as any;
  const published = await createJob();
  const send = (path: string, method = "GET", body?: object, auth = token) => f.app.request(path, authed(auth, { method, ...(body ? { body: JSON.stringify(body) } : {}) }));
  const getDraft = async () => await (await send("/api/drafts/" + draft!.id)).json() as any;
  return { ...f, ...storage(), token, userId, account: account!, draft: draft!, published, complete, createJob, send, getDraft };
}

describe("R2 归档保留证据（内存库与 mock 媒体）", () => {
  it("账号和草稿归档后发布、指标、趋势、复盘、素材关联均保留；恢复同 ID 不重排旧任务", async () => {
    const f = await fixture();
    const time = new Date();
    await f.db.update(publishJobs).set({ status: "done", noteId: "verified-note", outcome: "verified", publishedAt: time, verifiedAt: time }).where(eq(publishJobs.id, f.published.id));
    const [metric] = await f.db.insert(noteMetrics).values({ userId: f.userId, publishJobId: f.published.id, noteId: "verified-note", likes: 3, collects: 2, comments: 1, shares: 0 }).returning();
    const [snapshot] = await f.db.insert(accountSnapshots).values({ userId: f.userId, accountId: f.account.id, followers: 8 }).returning();
    const evidence = await postmortemEvidence(f.db, f.userId, f.published.id);
    const [report] = await f.db.insert(postmortemReports).values({ userId: f.userId, publishJobId: f.published.id, model: "mock", promptVersion: "test", evidence: evidence!, status: "done", engine: "data_only" }).returning();
    const [asset] = await f.db.insert(mediaAssets).values({ userId: f.userId, draftId: f.draft.id, uploadId: randomUUID(), sourceFile: randomUUID(), sourceHash: "a".repeat(64), filename: "ready.png", status: "ready", key: "upload/" + "a".repeat(64), url: "https://example.test/photo.png" }).returning();
    const pending = await f.createJob();
    const running = await f.createJob();
    expect((await claimBrowser(f.app, f.token, "publish", running.id)).status).toBe(200);
    expect((await f.send("/api/accounts/" + f.account.id, "DELETE")).status).toBe(200);
    expect((await f.send("/api/drafts/" + f.draft.id, "DELETE")).status).toBe(200);
    const archived = await f.getDraft();
    expect(archived.archivedAt).toBeTruthy(); expect(archived.images).toEqual(f.draft.images);
    expect(await (await f.send("/api/accounts")).json()).toEqual([]);
    expect(await (await f.send("/api/drafts")).json()).toEqual([]);
    expect(await (await f.send("/api/accounts?includeArchived=1")).json()).toHaveLength(1);
    expect(await (await f.send("/api/drafts?includeArchived=1")).json()).toHaveLength(1);
    const historical = await (await f.send("/api/insights/notes/" + f.published.id)).json() as any;
    expect(historical.evidence.content.title).toBe("发布时标题");
    expect(historical.evidence.metrics[0].id).toBe(metric!.id); expect(historical.reports[0].id).toBe(report!.id);
    const overview = await (await f.send("/api/insights/overview?accountId=" + f.account.id)).json() as any;
    expect(overview.accounts[0].points[0].id).toBe(snapshot!.id);
    expect((await f.db.select().from(mediaAssets).where(eq(mediaAssets.id, asset!.id)))[0]?.status).toBe("ready");
    const allJobs = await (await f.send("/api/publish/jobs")).json() as any[];
    expect(allJobs.find(j => j.id === pending.id).status).toBe("canceled");
    expect(allJobs.find(j => j.id === pending.id).retryEligibility.allowed).toBe(false);
    expect(allJobs.find(j => j.id === running.id).status).toBe("running");
    expect(allJobs.find(j => j.id === f.published.id).status).toBe("done");
    expect((await f.send("/api/accounts/" + f.account.id, "POST", {}, "other")).status).toBe(401);
    expect((await f.send("/api/accounts/" + f.account.id + "/restore", "POST")).status).toBe(200);
    expect((await f.send("/api/drafts/" + f.draft.id + "/restore", "POST")).status).toBe(200);
    expect((await f.getDraft()).id).toBe(f.draft.id);
    expect((await f.db.select().from(publishJobs).where(eq(publishJobs.id, pending.id)))[0]?.status).toBe("canceled");
    expect((await f.db.select().from(noteMetrics))).toHaveLength(1);
    expect((await f.db.select().from(accountSnapshots))).toHaveLength(1);
  });

  it("归档操作幂等、按用户隔离；归档后拒绝编辑/新发布/原版本重试，读列表不写 stale", async () => {
    const f = await fixture(); const other = await registerUser(f.app, "other@test.co");
    await f.db.update(hostedAccounts).set({ lastSeenAt: new Date(Date.now() - 3600_000) }).where(eq(hostedAccounts.id, f.account.id));
    expect((await (await f.send("/api/accounts")).json() as any[])[0].status).toBe("stale");
    expect((await f.db.select().from(hostedAccounts))[0]?.status).toBe("online");
    expect((await f.send("/api/accounts/" + f.account.id, "DELETE", undefined, other.token)).status).toBe(404);
    expect((await f.send("/api/drafts/" + f.draft.id, "DELETE", undefined, other.token)).status).toBe(404);
    expect((await f.send("/api/drafts/" + f.draft.id + "/restore", "POST", undefined, other.token)).status).toBe(404);
    expect((await f.send("/api/drafts/" + f.draft.id, "DELETE")).status).toBe(200);
    const first = await f.getDraft();
    expect((await f.send("/api/drafts/" + f.draft.id, "DELETE")).status).toBe(200);
    expect(await f.getDraft()).toMatchObject({ archivedAt: first.archivedAt, textVersion: first.textVersion, imagesVersion: first.imagesVersion, generationRevision: first.generationRevision, coverRevision: first.coverRevision });
    expect((await f.send("/api/drafts/" + f.draft.id, "PATCH", { title: "覆盖", textVersion: first.textVersion })).status).toBe(409);
    expect((await f.send("/api/publish/jobs", "POST", { draftId: f.draft.id, accountId: f.account.id })).status).toBe(409);
    expect((await f.send("/api/publish/jobs/" + f.published.id + "/retry", "POST", { operationId: randomUUID() })).status).toBe(409);
    expect((await f.send("/api/ai/rewrite", "POST", { draftId: f.draft.id })).status).toBe(409);
    expect((await f.send("/api/drafts/" + f.draft.id + "/cover", "POST", { revision: first.coverRevision, spec: { templateId: "poster", headline: "封面" } })).status).toBe(409);
    expect((await f.send("/api/accounts/" + f.account.id, "DELETE")).status).toBe(200);
    expect((await f.send("/api/accounts/" + f.account.id, "PATCH", { version: 0, positioning: "变更" })).status).toBe(409);
    expect((await f.send("/api/drafts", "POST", { accountId: f.account.id })).status).toBe(409);
    expect((await f.send("/api/topics", "POST", { title: "新选题", accountId: f.account.id })).status).toBe(409);
  });

  it("物理删除有证据的账号/草稿/发布被 RESTRICT 阻止，不能触发历史级联丢失", async () => {
    const f = await fixture();
    await expect(f.db.delete(hostedAccounts).where(eq(hostedAccounts.id, f.account.id))).rejects.toThrow();
    await expect(f.db.delete(drafts).where(eq(drafts.id, f.draft.id))).rejects.toThrow();
    await f.db.insert(noteMetrics).values({ userId: f.userId, publishJobId: f.published.id, noteId: "metric-only-history", likes: 0 });
    // Even without any review report, metrics retain their publication attribution.
    await expect(f.db.delete(publishJobs).where(eq(publishJobs.id, f.published.id))).rejects.toThrow();
    expect((await f.db.select().from(noteMetrics))[0]?.publishJobId).toBe(f.published.id);
    const evidence = await postmortemEvidence(f.db, f.userId, f.published.id);
    await f.db.insert(postmortemReports).values({ userId: f.userId, publishJobId: f.published.id, model: "mock", promptVersion: "test", evidence: evidence! });
    await expect(f.db.delete(publishJobs).where(eq(publishJobs.id, f.published.id))).rejects.toThrow();
    expect((await f.db.select().from(publishJobs))).toHaveLength(1);
  });

  it.each(["draft", "account"] as const)("模型等待期间归档 %s 后迟到结果不成稿，不排封面", async target => {
    let release!: () => void, started!: () => void;
    const begin = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture(vi.fn(async () => { started(); await wait; return JSON.stringify({ title: "迟到标题", content: "迟到正文", tags: [], cover: "迟到封面" }); }));
    f.deps.r2 = f.r2;
    const [topic] = await f.db.insert(topics).values({ userId: f.userId, title: "生成选题", angle: "保留原事实", accountId: f.account.id }).returning();
    const accepted = await (await f.send("/api/topics/" + topic!.id + "/to-draft", "POST", { ai: true })).json() as any;
    const processing = runDraftJobs(f.deps); await begin;
    expect((await f.send(target === "draft" ? "/api/drafts/" + accepted.draft.id : "/api/accounts/" + f.account.id, "DELETE")).status).toBe(200);
    if (target === "draft") {
      expect((await f.send("/api/topics/" + topic!.id + "/to-draft", "POST", { ai: true })).status).toBe(409);
      // An explicit restore must not re-authorize the in-flight result from before the archive.
      expect((await f.send("/api/drafts/" + accepted.draft.id + "/restore", "POST")).status).toBe(200);
    } else expect((await f.send("/api/accounts/" + f.account.id + "/restore", "POST")).status).toBe(200);
    release(); await processing;
    const draft = await (await f.send("/api/drafts/" + accepted.draft.id)).json() as any;
    expect(draft.content).toBe(""); expect(draft.generationState).toBe("failed");
    expect((await f.db.select().from(jobs).where(eq(jobs.type, "cover_generate")))).toHaveLength(0);
    const generation = (await f.db.select().from(jobs).where(eq(jobs.type, "draft_generate")))[0]!;
    expect(generation.status).toBe("canceled");
  });

  it("归档发生于封面 PUT 后，旧任务不覆盖历史封面/图片；GC 保留已归档稿的媒体", async () => {
    const f = await fixture(); f.deps.r2 = f.r2;
    const key = "upload/" + "b".repeat(64), url = "http://localhost/api/media/objects/" + key;
    f.objects.set(key, { bytes: Uint8Array.from([1, 2, 3]).buffer, type: "image/png" });
    await f.db.update(drafts).set({ images: [{ url }] }).where(eq(drafts.id, f.draft.id));
    const accepted = await (await f.send("/api/drafts/" + f.draft.id + "/cover", "POST", { revision: 0, spec: { templateId: "poster", headline: "新封面" } })).json() as any;
    let release!: () => void, started!: () => void;
    const begin = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.r2.put).mockImplementationOnce(async (k, bytes, type) => { started(); await wait; f.objects.set(k, { bytes, type }); });
    const processing = runCoverJobs(f.deps); await begin;
    expect((await f.send("/api/drafts/" + f.draft.id, "DELETE")).status).toBe(200);
    const archived = await f.getDraft(); release(); await processing;
    expect((await f.getDraft()).images).toEqual(archived.images);
    expect((await f.db.select().from(mediaAssets).where(eq(mediaAssets.id, accepted.draft.coverAssetId)))[0]?.status).toBe("canceled");
    expect((await f.db.select().from(jobs).where(eq(jobs.type, "cover_generate")))[0]?.status).toBe("canceled");
    await pruneMedia(f.deps);
    expect(f.r2.delete).not.toHaveBeenCalledWith(key);
  });

  it("处理上传期间归档后补报不改变图集，ready 历史素材和原任务仍留库", async () => {
    const f = await fixture(); f.deps.r2 = f.r2;
    f.deps.uploadDir = await mkdtemp(join(tmpdir(), "v2media-history-")); directories.push(f.deps.uploadDir);
    const bytes = await sharp({ create: { width: 12, height: 12, channels: 3, background: "blue" } }).png().toBuffer();
    const form = new FormData(); form.set("draftId", String(f.draft.id)); form.set("imagesVersion", "0"); form.set("uploadId", randomUUID());
    form.set("file", new File([Uint8Array.from(bytes)], "own.png", { type: "image/png" }));
    const response = await f.app.request("/api/media/upload", { method: "POST", headers: { Authorization: "Bearer " + f.token }, body: form });
    expect(response.status).toBe(202); const accepted = await response.json() as any;
    let release!: () => void, started!: () => void;
    const begin = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(f.r2.put).mockImplementationOnce(async (key, bytes, type) => { started(); await wait; f.objects.set(key, { bytes, type }); });
    const processing = runUploadJobs(f.deps); await begin;
    expect((await f.send("/api/drafts/" + f.draft.id, "DELETE")).status).toBe(200);
    const archived = await f.getDraft(); release(); await processing;
    expect((await f.getDraft()).images).toEqual(archived.images);
    expect((await f.db.select().from(mediaAssets).where(eq(mediaAssets.id, accepted.asset.id)))[0]?.status).toBe("canceled");
    expect((await f.db.select().from(jobs).where(eq(jobs.type, "media_upload")))[0]?.status).toBe("canceled");
    expect((await f.send("/api/media/assets/" + accepted.asset.id + "/retry", "POST")).status).toBe(409);
  });
});
