import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { BROWSER_EXECUTION_CAPABILITY as capability } from "@v2media/shared";
import { accountSnapshots, drafts, hostedAccounts, jobs, noteMetrics, publishJobs } from "../src/db/schema";
import { authed, makeApp, registerUser } from "./helpers";

async function fixture() {
  const f = await makeApp();
  const { token, userId } = await registerUser(f.app);
  let now = new Date("2026-10-02T01:00:00Z"); f.deps.now = () => now;
  const request = (path: string, body?: unknown) => f.app.request(path, authed(token, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }));
  const heartbeat = (accounts: unknown[]) => request("/api/ext/accounts/heartbeat", { accounts });
  const observed = { xhsUserId: "identity-one", subType: "creator", nickname: "原账号", avatar: "https://example.com/a.png", status: "online" };
  return { ...f, token, userId, request, heartbeat, observed, advance: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

describe("hosted account identity", () => {
  it("concurrent canonical heartbeats create one identity and one snapshot task", async () => {
    const f = await fixture();
    const responses = await Promise.all(Array.from({ length: 12 }, (_, i) => f.heartbeat([{ ...f.observed, xhsUserId: i % 2 ? " identity-one " : "identity-one" }])));
    expect(responses.every(r => r.status === 200)).toBe(true);
    const accounts = await f.db.select().from(hostedAccounts);
    expect(accounts).toHaveLength(1); expect(accounts[0]!.xhsUserId).toBe("identity-one");
    const tasks = await f.db.select().from(jobs).where(eq(jobs.type, "account_snapshot"));
    expect(tasks).toHaveLength(1); expect((tasks[0]!.payload as { accountId: number }).accountId).toBe(accounts[0]!.id);
  });

  it("pc, creator and different users retain independent identity and persona", async () => {
    const f = await fixture(), other = await registerUser(f.app, "another@example.com");
    await f.heartbeat([{ ...f.observed, subType: "pc" }, f.observed]);
    expect((await f.app.request("/api/ext/accounts/heartbeat", authed(other.token, { method: "POST", body: JSON.stringify({ accounts: [f.observed] }) }))).status).toBe(200);
    const rows = await f.db.select().from(hostedAccounts);
    expect(rows).toHaveLength(3);
    expect(rows.filter(a => a.userId === f.userId).map(a => a.subType).sort()).toEqual(["creator", "pc"]);
    expect(await f.db.select().from(jobs).where(eq(jobs.type, "account_snapshot"))).toHaveLength(3);
    const pc = rows.find(a => a.userId === f.userId && a.subType === "pc")!;
    await f.db.update(hostedAccounts).set({ positioning: "原定位", styleNotes: "原风格", redlines: "原红线", personaVersion: 7 }).where(eq(hostedAccounts.id, pc.id));
    f.advance(60_000);
    await f.heartbeat([{ ...f.observed, subType: "pc", nickname: "", avatar: "", status: "expired", statusMessage: "重新登录" }]);
    const updated = (await f.db.select().from(hostedAccounts).where(eq(hostedAccounts.id, pc.id)))[0]!;
    expect(updated).toMatchObject({ nickname: "原账号", avatar: f.observed.avatar, positioning: "原定位", styleNotes: "原风格", redlines: "原红线", personaVersion: 7, status: "expired", statusMessage: "重新登录" });
    expect(updated.lastSeenAt).toEqual(f.deps.now());
  });

  it("invalid or duplicate batch identities reject the whole heartbeat", async () => {
    const f = await fixture();
    for (const xhsUserId of ["", "  ", "bad id", "bad\nidentity", "x".repeat(129), null]) {
      expect((await f.heartbeat([f.observed, { ...f.observed, xhsUserId }])).status).toBe(400);
    }
    expect((await f.heartbeat([f.observed, { ...f.observed, xhsUserId: " identity-one " }])).status).toBe(400);
    expect(await f.db.select().from(hostedAccounts)).toHaveLength(0);
    expect(await f.db.select().from(jobs)).toHaveLength(0);
  });

  it("heartbeat updates observations without restoring archived identity or scheduling work", async () => {
    const f = await fixture();
    await f.heartbeat([{ ...f.observed, status: "expired" }]);
    const [account] = await f.db.select().from(hostedAccounts);
    await f.db.update(hostedAccounts).set({ archivedAt: f.deps.now(), positioning: "历史人设", personaVersion: 3 }).where(eq(hostedAccounts.id, account!.id));
    f.advance(60_000);
    expect((await f.heartbeat([{ ...f.observed, nickname: "新观察名" }])).status).toBe(200);
    const rows = await f.db.select().from(hostedAccounts);
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ id: account!.id, nickname: "新观察名", positioning: "历史人设", personaVersion: 3 });
    expect(rows[0]!.archivedAt).toEqual(account!.lastSeenAt);
    expect(await f.db.select().from(jobs)).toHaveLength(0);
  });

  it("snapshot scheduling failure rolls back the identity observation", async () => {
    const f = await fixture();
    await f.db.execute(sql`ALTER TABLE jobs ADD CONSTRAINT reject_identity_snapshot CHECK (type <> 'account_snapshot')`);
    expect((await f.heartbeat([f.observed])).status).toBe(500);
    expect(await f.db.select().from(hostedAccounts)).toHaveLength(0);
    expect(await f.db.select().from(jobs)).toHaveLength(0);
    await f.db.execute(sql`ALTER TABLE jobs DROP CONSTRAINT reject_identity_snapshot`);
    expect((await f.heartbeat([f.observed])).status).toBe(200);
    expect(await f.db.select().from(hostedAccounts)).toHaveLength(1);
    expect(await f.db.select().from(jobs)).toHaveLength(1);
  });

  it("recent snapshots suppress rescheduling; concurrent later heartbeats schedule once", async () => {
    const f = await fixture();
    await f.heartbeat([f.observed]);
    const [account] = await f.db.select().from(hostedAccounts);
    await f.db.update(jobs).set({ status: "done" }).where(eq(jobs.type, "account_snapshot"));
    await f.db.insert(accountSnapshots).values({ userId: f.userId, accountId: account!.id, capturedAt: f.deps.now(), followers: 2 });
    f.advance(19 * 60 * 60_000);
    await f.heartbeat([f.observed]);
    expect(await f.db.select().from(jobs)).toHaveLength(1);
    f.advance(2 * 60 * 60_000);
    await Promise.all([f.heartbeat([f.observed]), f.heartbeat([f.observed])]);
    const rows = await f.db.select().from(jobs);
    expect(rows).toHaveLength(2); expect(rows.filter(j => j.status === "pending")).toHaveLength(1);
  });

  it("archive prevents later publish click and new snapshots, while receipts and historical metrics survive", async () => {
    const f = await fixture(); await f.heartbeat([{ ...f.observed, status: "expired" }]);
    const [account] = await f.db.select().from(hostedAccounts);
    const [draft] = await f.db.insert(drafts).values({ userId: f.userId, title: "历史正文", images: [{ url: "https://example.com/i.png" }] }).returning();
    const [job] = await f.db.insert(publishJobs).values({ userId: f.userId, draftId: draft!.id, accountId: account!.id, draftSnapshot: { title: "历史正文", content: "", tags: [], images: [{ url: "https://example.com/i.png" }] } }).returning();
    expect((await (await f.request("/api/ext/publish/pending")).json() as any).jobs[0].xhsUserId).toBe(f.observed.xhsUserId);
    const lease = await (await f.request(`/api/ext/publish/${job!.id}/claim`, { capability, claimedBy: "sw-original" })).json() as any;
    await f.db.update(hostedAccounts).set({ archivedAt: f.deps.now() }).where(eq(hostedAccounts.id, account!.id));
    await f.db.update(drafts).set({ archivedAt: f.deps.now() }).where(eq(drafts.id, draft!.id));
    const heartbeat = { capability, claimedBy: lease.claimedBy, leaseId: lease.leaseId, attempt: lease.attempt };
    expect((await f.request(`/api/ext/publish/${job!.id}/heartbeat`, heartbeat)).status).toBe(409);
    expect((await f.request(`/api/ext/publish/${job!.id}?claimer=sw-original&capability=${capability}`)).status).toBe(409);
    const [pending] = await f.db.insert(publishJobs).values({ userId: f.userId, draftId: draft!.id, accountId: account!.id }).returning();
    expect((await f.request(`/api/ext/publish/${pending!.id}/claim`, { capability, claimedBy: "sw-new" })).status).toBe(404);
    expect((await f.request(`/api/ext/publish/${pending!.id}`)).status).toBe(409);
    expect((await (await f.request("/api/ext/publish/pending")).json() as any).jobs).toHaveLength(0);
    expect((await f.request(`/api/ext/publish/${job!.id}/result`, { ...heartbeat, receiptId: randomUUID(), status: "done" })).status).toBe(200);
    f.advance(11 * 60_000);
    const [readback] = await f.db.select().from(jobs).where(eq(jobs.type, "readback"));
    const readLease = await (await f.request(`/api/ext/tasks/${readback!.id}/claim`, { capability, claimedBy: "sw-reader" })).json() as any;
    expect((await f.request(`/api/ext/tasks/${readback!.id}/result`, { capability, claimedBy: readLease.claimedBy, leaseId: readLease.leaseId, attempt: readLease.attempt, receiptId: randomUUID(), status: "done", data: { items: [{ noteId: "history-note", title: "历史正文", publishTime: f.deps.now().getTime() }] } })).status).toBe(200);
    f.advance(2 * 60 * 60_000);
    const [metric] = await f.db.select().from(jobs).where(eq(jobs.type, "metrics"));
    const metricLease = await (await f.request(`/api/ext/tasks/${metric!.id}/claim`, { capability, claimedBy: "sw-reader" })).json() as any;
    expect((await f.request(`/api/ext/tasks/${metric!.id}/result`, { capability, claimedBy: metricLease.claimedBy, leaseId: metricLease.leaseId, attempt: metricLease.attempt, receiptId: randomUUID(), status: "done", data: { rows: [{ noteId: "history-note", likes: 0 }] } })).status).toBe(200);
    expect(await f.db.select().from(noteMetrics)).toHaveLength(1);
    const [snapshot] = await f.db.insert(jobs).values({ userId: f.userId, type: "account_snapshot", payload: { accountId: account!.id, xhsUserId: account!.xhsUserId } }).returning();
    expect((await f.request(`/api/ext/tasks/${snapshot!.id}/claim`, { capability, claimedBy: "sw-new" })).status).toBe(404);
    expect((await f.request(`/api/ext/tasks/${snapshot!.id}`)).status).toBe(409);
    expect((await (await f.request("/api/ext/tasks/pending")).json() as any).tasks.some((t: any) => t.id === snapshot!.id)).toBe(false);
  });

  it("a snapshot already running can report evidence after its account is archived", async () => {
    const f = await fixture(); await f.heartbeat([f.observed]);
    const [account] = await f.db.select().from(hostedAccounts);
    const [task] = await f.db.select().from(jobs);
    const lease = await (await f.request(`/api/ext/tasks/${task!.id}/claim`, { capability, claimedBy: "sw-reader" })).json() as any;
    await f.db.update(hostedAccounts).set({ archivedAt: f.deps.now() }).where(eq(hostedAccounts.id, account!.id));
    const body = { capability, claimedBy: lease.claimedBy, leaseId: lease.leaseId, attempt: lease.attempt, receiptId: randomUUID(), status: "done", data: { followers: 0 } };
    expect((await f.request(`/api/ext/tasks/${task!.id}/result`, body)).status).toBe(200);
    expect((await f.request(`/api/ext/tasks/${task!.id}/result`, body)).status).toBe(200);
    const evidence = await f.db.select().from(accountSnapshots);
    expect(evidence).toHaveLength(1); expect(evidence[0]!.accountId).toBe(account!.id); expect(evidence[0]!.followers).toBe(0);
  });

  it("reading expired attribution candidates does not mutate their lease before a fenced claim", async () => {
    const f = await fixture(); await f.heartbeat([f.observed]);
    const [task] = await f.db.select().from(jobs);
    const lease = await (await f.request(`/api/ext/tasks/${task!.id}/claim`, { capability, claimedBy: "sw-old" })).json() as any;
    f.advance(3 * 60_000);
    const before = (await f.db.select().from(jobs))[0]!;
    expect((await (await f.request("/api/ext/tasks/pending")).json() as any).tasks).toHaveLength(1);
    expect((await f.db.select().from(jobs))[0]).toEqual(before);
    const responses = await Promise.all([f.request(`/api/ext/tasks/${task!.id}/claim`, { capability, claimedBy: "sw-one" }), f.request(`/api/ext/tasks/${task!.id}/claim`, { capability, claimedBy: "sw-two" })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 404]);
    const current = (await f.db.select().from(jobs))[0]!;
    expect(current.attempt).toBe(lease.attempt + 1); expect(current.leaseId).not.toBe(lease.leaseId);
    expect((await f.request(`/api/ext/tasks/${task!.id}/result`, { capability, claimedBy: lease.claimedBy, leaseId: lease.leaseId, attempt: lease.attempt, receiptId: randomUUID(), status: "done", data: { followers: 3 } })).status).toBe(409);
  });
});
