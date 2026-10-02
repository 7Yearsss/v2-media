import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { drafts, hostedAccounts, publishJobs, topics } from "../src/db/schema";
import { authed, claimBrowser, makeApp, registerUser, reportBrowser } from "./helpers";

async function fixture() {
  const f = await makeApp();
  const { token, userId } = await registerUser(f.app);
  let now = new Date("2026-10-02T00:00:00Z"); f.deps.now = () => now;
  const [account] = await f.db.insert(hostedAccounts).values({ userId, xhsUserId: "original-xhs", nickname: "原账号", personaVersion: 1, positioning: "原定位", styleNotes: "原风格", redlines: "原红线" }).returning();
  const coverSpec = { templateId: "poster" as const, templateVersion: 1, headline: "原封面" };
  const [draft] = await f.db.insert(drafts).values({ userId, accountId: account!.id, title: "原标题", content: "原正文", tags: ["原标签"], images: [{ url: "https://example.com/original.png" }], coverSpec }).returning();
  const [topic] = await f.db.insert(topics).values({ userId, accountId: account!.id, draftId: draft!.id, title: "原选题", score: 71, scoreMethod: "seven-v1", scoreModel: "mock", scoredAt: now }).returning();
  const request = (path: string, body?: unknown) => f.app.request(path, authed(token, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
  const create = async (visibility: "public" | "friends" | "private" = "friends") => {
    const response = await request("/api/publish/jobs", { draftId: draft!.id, accountId: account!.id, personaVersion: 1, visibility, scheduledAt: now.getTime() + 60_000 });
    expect(response.status).toBe(200); return await response.json() as any;
  };
  const cancel = async (id: number) => { expect((await request(`/api/publish/jobs/${id}/cancel`, {})).status).toBe(200); };
  const fail = async (id: number) => {
    expect((await claimBrowser(f.app, token, "publish", id)).status).toBe(200);
    expect((await reportBrowser(f.app, token, "publish", id, { status: "failed", error: "点击前图片下载失败" })).status).toBe(200);
  };
  const retry = (id: number, operationId = randomUUID()) => request(`/api/publish/jobs/${id}/retry`, { operationId });
  return { ...f, token, userId, account: account!, draft: draft!, topic: topic!, request, create, cancel, fail, retry, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("publish original snapshot retry", () => {
  it("new publications reject text or image versions changed since the user's review", async () => {
    const f = await fixture();
    const create = (versions: object) => f.request("/api/publish/jobs", { draftId: f.draft.id, accountId: f.account.id, personaVersion: 1, ...versions });
    await f.db.update(drafts).set({ title: "另一标签页修改", textVersion: 1, imagesVersion: 1, images: [{ url: "https://example.com/updated.png" }] }).where(eq(drafts.id, f.draft.id));
    expect((await create({ draftTextVersion: 0, draftImagesVersion: 1 })).status).toBe(409);
    expect((await create({ draftTextVersion: 1, draftImagesVersion: 0 })).status).toBe(409);
    expect(await f.db.select().from(publishJobs)).toHaveLength(0);
    const current = await create({ draftTextVersion: 1, draftImagesVersion: 1 });
    expect(current.status).toBe(200); expect((await current.json() as any).draftSnapshot.title).toBe("另一标签页修改");
    expect((await create({})).status).toBe(200);
  });

  it("copies the original draft, persona, identity, cover and planning after current objects change", async () => {
    const f = await fixture(), original = await f.create(); await f.fail(original.id);
    await f.db.update(drafts).set({ title: "后来标题", content: "后来正文", tags: ["后来标签"], images: [{ url: "https://example.com/new.png" }], coverSpec: { templateId: "poster", headline: "后来封面" }, textVersion: 1 }).where(eq(drafts.id, f.draft.id));
    await f.db.update(hostedAccounts).set({ personaVersion: 2, nickname: "后来昵称", positioning: "后来定位", styleNotes: "后来风格", redlines: "后来红线" }).where(eq(hostedAccounts.id, f.account.id));
    await f.db.update(topics).set({ title: "后来选题", score: 99 }).where(eq(topics.id, f.topic.id));
    const response = await f.retry(original.id); expect(response.status).toBe(200);
    const retried = await response.json() as any;
    expect(retried.id).not.toBe(original.id); expect(retried.status).toBe("pending"); expect(retried.scheduledAt).toBeNull(); expect(retried.retryOfJobId).toBe(original.id);
    for (const field of ["draftSnapshot", "personaSnapshot", "accountSnapshot", "coverSnapshot", "planningSnapshot", "visibility", "draftId", "accountId"]) expect(retried[field]).toEqual(original[field]);
    expect(retried.attempt).toBe(0); expect(retried.leaseId).toBeNull(); expect(retried.error).toBeNull(); expect(retried.reportedAt).toBeNull();
    const listed = await (await f.request("/api/publish/jobs")).json() as any[];
    expect(listed.find(job => job.id === original.id).draftSnapshot.title).toBe("原标题"); expect(listed.find(job => job.id === original.id).retryEligibility.allowed).toBe(false);
    const pending = await (await f.request("/api/ext/publish/pending?all=1")).json() as any;
    expect(pending.jobs.find((job: any) => job.id === retried.id).draft).toEqual(original.draftSnapshot);
    expect(pending.jobs.find((job: any) => job.id === retried.id).xhsUserId).toBe("original-xhs");
  });

  it("retries pre-execution cancel and acknowledges a lost response or concurrent click with one job", async () => {
    const f = await fixture(), original = await f.create(); await f.cancel(original.id);
    const operationId = randomUUID();
    const responses = await Promise.all([f.retry(original.id, operationId), f.retry(original.id, operationId)]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    const bodies = await Promise.all(responses.map(response => response.json())) as any[];
    expect(bodies[0].id).toBe(bodies[1].id); expect(await f.db.select().from(publishJobs)).toHaveLength(2);
    await claimBrowser(f.app, f.token, "publish", bodies[0].id);
    const replay = await (await f.retry(original.id, operationId)).json() as any;
    expect(replay.id).toBe(bodies[0].id); expect(replay.status).toBe("running");
    const other = await f.create(); await f.cancel(other.id);
    expect((await f.retry(other.id, operationId)).status).toBe(409);
  });

  it("rejects pending, done, running and expired unknown results without creating a new publication", async () => {
    const f = await fixture(), original = await f.create();
    expect((await f.retry(original.id)).status).toBe(409);
    await claimBrowser(f.app, f.token, "publish", original.id);
    expect((await f.retry(original.id)).status).toBe(409);
    f.advance(11 * 60_000); expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ status: "done" }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    expect(await f.db.select().from(publishJobs)).toHaveLength(1);
  });

  it("blocks a new operation while the same original version is queued, running or already published", async () => {
    const f = await fixture(), original = await f.create(); await f.cancel(original.id);
    const operationId = randomUUID(), first = await (await f.retry(original.id, operationId)).json() as any;
    expect((await f.retry(original.id)).status).toBe(409);
    const listed = await (await f.request("/api/publish/jobs")).json() as any[];
    expect(listed.find(job => job.id === original.id).retryEligibility.reason).toContain(`#${first.id}`);
    await claimBrowser(f.app, f.token, "publish", first.id);
    expect((await f.retry(original.id)).status).toBe(409);
    await reportBrowser(f.app, f.token, "publish", first.id, { status: "done" });
    expect((await f.retry(original.id)).status).toBe(409);
    expect((await (await f.retry(original.id, operationId)).json() as any).id).toBe(first.id);
    expect(await f.db.select().from(publishJobs)).toHaveLength(2);
  });

  it("does not treat old failed rows or a cancellation after claim as proof the platform did not publish", async () => {
    const f = await fixture(), original = await f.create();
    await f.db.update(publishJobs).set({ status: "failed", error: "旧版超时" }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ status: "failed", attempt: 1, claimedBy: "legacy", leaseId: randomUUID() }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ status: "canceled" }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    const listed = await (await f.request("/api/publish/jobs")).json() as any[];
    expect(listed[0].retryEligibility.allowed).toBe(false); expect(listed[0].retryEligibility.reason).toContain("人工核对");
  });

  it("rejects missing legacy snapshots and changed account identity or ownership", async () => {
    const f = await fixture(), original = await f.create(); await f.cancel(original.id);
    await f.db.update(publishJobs).set({ accountSnapshot: null }).where(eq(publishJobs.id, original.id));
    const missing = await f.retry(original.id); expect(missing.status).toBe(409); expect((await missing.json() as any).error).toContain("快照");
    await f.db.update(publishJobs).set({ accountSnapshot: original.accountSnapshot, personaSnapshot: null }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ personaSnapshot: original.personaSnapshot, draftSnapshot: null }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ draftSnapshot: { ...original.draftSnapshot, title: 5 } as any }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ draftSnapshot: original.draftSnapshot }).where(eq(publishJobs.id, original.id));
    await f.db.update(hostedAccounts).set({ xhsUserId: "different-xhs" }).where(eq(hostedAccounts.id, f.account.id));
    expect((await f.retry(original.id)).status).toBe(409);
    const other = await registerUser(f.app, "other@example.com");
    expect((await f.app.request(`/api/publish/jobs/${original.id}/retry`, authed(other.token, { method: "POST", body: JSON.stringify({ operationId: randomUUID() }) }))).status).toBe(404);
    await f.db.update(hostedAccounts).set({ xhsUserId: "original-xhs", userId: other.userId }).where(eq(hostedAccounts.id, f.account.id));
    expect((await f.retry(original.id)).status).toBe(409);
    expect(await f.db.select().from(publishJobs)).toHaveLength(1);
  });

  it("rejects conflicting published evidence and attempts to override snapshot fields", async () => {
    const f = await fixture(), original = await f.create(); await f.fail(original.id);
    await f.db.update(publishJobs).set({ resultUrl: "https://www.xiaohongshu.com/explore/already-published" }).where(eq(publishJobs.id, original.id));
    expect((await f.retry(original.id)).status).toBe(409);
    await f.db.update(publishJobs).set({ resultUrl: null }).where(eq(publishJobs.id, original.id));
    expect((await f.request(`/api/publish/jobs/${original.id}/retry`, { operationId: randomUUID(), visibility: "public", scheduledAt: Date.now() })).status).toBe(400);
    expect((await f.request(`/api/publish/jobs/${original.id}/retry`, { operationId: "not-a-uuid" })).status).toBe(400);
    expect((await f.retry(original.id)).status).toBe(200);
  });

  it("rolls back retry creation and leaves its operation reusable after a database failure", async () => {
    const f = await fixture(), original = await f.create(); await f.cancel(original.id);
    const operationId = randomUUID();
    await f.db.execute(sql`ALTER TABLE publish_jobs ADD CONSTRAINT test_reject_retry CHECK (retry_operation_id IS NULL)`);
    expect((await f.retry(original.id, operationId)).status).toBe(500);
    expect(await f.db.select().from(publishJobs)).toHaveLength(1);
    await f.db.execute(sql`ALTER TABLE publish_jobs DROP CONSTRAINT test_reject_retry`);
    expect((await f.retry(original.id, operationId)).status).toBe(200);
    expect(await f.db.select().from(publishJobs)).toHaveLength(2);
  });
});
