import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { expect, it } from "vitest";
import type { WorkspaceTasksResponse } from "@v2media/shared";
import { aiRuns, collections, collectionTasks, drafts, hostedAccounts, jobs, mediaAssets, publishJobs } from "../src/db/schema";
import { authed, makeApp, registerUser } from "./helpers";

it("workspace observation scopes every related row, redacts private data and does not recover expired executions in readonly mode", async () => {
  const f = await makeApp(), own = await registerUser(f.app), other = await registerUser(f.app, "tasks-other@isolated.test");
  const now = new Date("2026-10-02T04:00:00Z"), expired = new Date(now.getTime() - 1); f.deps.now = () => now;
  const [account] = await f.db.insert(hostedAccounts).values({ userId: own.userId, xhsUserId: "own", nickname: "自己的账号" }).returning();
  const [otherAccount] = await f.db.insert(hostedAccounts).values({ userId: other.userId, xhsUserId: "other", nickname: "foreign-secret-account" }).returning();
  const [draft] = await f.db.insert(drafts).values({ userId: own.userId, accountId: account!.id, title: "自己的草稿" }).returning();
  const [foreignDraft] = await f.db.insert(drafts).values({ userId: other.userId, accountId: otherAccount!.id, title: "foreign-secret-draft" }).returning();
  const [publication] = await f.db.insert(publishJobs).values({ userId: own.userId, draftId: draft!.id, accountId: account!.id,
    status: "running", leaseId: randomUUID(), leaseUntil: expired, claimedBy: "private-claimer", error: "provider-secret-key" }).returning();
  const [collection] = await f.db.insert(collections).values({ userId: own.userId, name: "自己的采集库" }).returning();
  const [run] = await f.db.insert(aiRuns).values({ userId: own.userId, kind: "topic_generate", targetType: "collection", targetId: collection!.id,
    operationId: randomUUID(), inputHash: "private-input-hash", requestHash: "private-request-hash", frozenInput: { persona: { accountId: account!.id }, prompt: "provider-secret-key" },
    model: "fixture", promptVersion: "fixture", status: "running", leaseId: randomUUID(), leaseUntil: expired }).returning();
  const [asset] = await f.db.insert(mediaAssets).values({ userId: own.userId, draftId: draft!.id, uploadId: randomUUID(), filename: "secret-filename.png", sourceFile: "private-source-file", sourceHash: "private-source-hash" }).returning();
  await f.db.insert(jobs).values([
    { userId: own.userId, type: "media_upload", status: "queued", payload: { assetId: asset!.id, base: "https://credential.example" } },
    { userId: own.userId, type: "readback", status: "running", leaseId: randomUUID(), leaseUntil: expired, payload: { publishJobId: publication!.id, xhsUserId: "credential", title: "snapshot-secret" } },
    { userId: own.userId, type: "metrics", status: "pending", dueAt: new Date(now.getTime() + 60_000), payload: { publishJobId: publication!.id } },
    { userId: own.userId, type: "account_snapshot", status: "failed", error: "provider-secret-key", payload: { accountId: account!.id } },
    { userId: own.userId, type: "cover_generate", status: "queued", payload: { draftId: foreignDraft!.id } },
    { userId: other.userId, type: "draft_generate", status: "queued", payload: { draftId: foreignDraft!.id } },
  ]);
  await f.db.insert(collectionTasks).values({ userId: own.userId, collectionId: collection!.id, collectionName: collection!.name,
    rules: { keyword: "fixture", collectionId: collection!.id, minLikes: 0, scanLimit: 10, saveLimit: 5, commentLimit: 0, intervalMs: 3000 }, status: "blocked", reason: "provider-secret-key" });
  const snapshot = async () => (await f.db.execute(sql`SELECT jsonb_build_object(
    'ai', (SELECT jsonb_agg(to_jsonb(r)) FROM ai_runs r), 'jobs', (SELECT jsonb_agg(to_jsonb(r)) FROM jobs r),
    'publish', (SELECT jsonb_agg(to_jsonb(r)) FROM publish_jobs r), 'collection', (SELECT jsonb_agg(to_jsonb(r)) FROM collection_tasks r)) state`) as { rows: Array<{ state: unknown }> }).rows[0]!.state;
  const before = await snapshot(); f.deps.runtimeMode = "production-readonly";
  const response = await f.app.request("/api/workspace/tasks", authed(own.token)); expect(response.status).toBe(200);
  const body = await response.json() as WorkspaceTasksResponse;
  expect(body.items).toHaveLength(8);
  expect(body.items.find(item => item.source === "publish")).toMatchObject({ id: publication!.id, state: "unknown", rawStatus: "running", bucket: "attention", href: `/publish?job=${publication!.id}` });
  expect(body.items.find(item => item.key === `ai_run:${run!.id}`)).toMatchObject({ state: "running", account: { id: account!.id }, href: "/topics" });
  expect(body.items.find(item => item.kind === "media_upload")).toMatchObject({ object: { id: draft!.id }, href: `/drafts/${draft!.id}` });
  expect(body.items.find(item => item.kind === "cover_generate")?.object).toBeNull();
  expect(body.items.find(item => item.kind === "metrics")).toMatchObject({ nextCheckKind: "scheduled", nextCheckAt: "2026-10-02T04:01:00.000Z" });
  expect(JSON.stringify(body)).not.toMatch(/provider-secret|foreign-secret|private-|snapshot-secret|secret-filename|credential\.example|frozenInput|payload|leaseId|claimedBy|inputHash|requestHash/);
  expect(await snapshot()).toEqual(before);
  const scoped = await (await f.app.request(`/api/workspace/tasks?accountId=${account!.id}`, authed(own.token))).json() as WorkspaceTasksResponse;
  expect(scoped.items).toHaveLength(6); expect(scoped.items.every(item => item.account?.id === account!.id)).toBe(true);
  expect(scoped.counts).toEqual({ active: 4, attention: 2, completed: 0 });
  const attention = await (await f.app.request("/api/workspace/tasks?filter=attention", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(attention.items.some(item => item.state === "unknown")).toBe(true); expect(attention.refreshAfterMs).toBeNull();
  const otherResult = await (await f.app.request("/api/workspace/tasks", authed(other.token))).json() as WorkspaceTasksResponse;
  expect(otherResult.items).toHaveLength(1); expect(otherResult.items[0]?.object?.id).toBe(foreignDraft!.id);
  expect((await f.app.request(`/api/workspace/tasks?accountId=${otherAccount!.id}`, authed(own.token))).status).toBe(404);
  expect((await f.app.request("/api/workspace/tasks?filter=bad", authed(own.token))).status).toBe(400);
  expect((await f.app.request("/api/workspace/tasks")).status).toBe(401);
  const validUntil = new Date(now.getTime() + 60_000);
  await f.db.update(publishJobs).set({ leaseUntil: validUntil }).where(eq(publishJobs.id, publication!.id));
  const valid = await (await f.app.request("/api/workspace/tasks", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(valid.items.find(item => item.source === "publish")).toMatchObject({ state: "running", rawStatus: "running", bucket: "active", nextCheckAt: validUntil.toISOString(), nextCheckKind: "lease" });
});

it("completed history cannot crowd out older active and failed tasks, and every capped range is explicit", async () => {
  const f = await makeApp(), own = await registerUser(f.app), now = new Date("2026-10-02T04:00:00Z"); f.deps.now = () => now;
  const [collection] = await f.db.insert(collections).values({ userId: own.userId, name: "queue fixture" }).returning();
  const base = { userId: own.userId, kind: "topic_generate" as const, targetType: "collection" as const, targetId: collection!.id,
    inputHash: "fixture", requestHash: "fixture", frozenInput: {}, model: "fixture", promptVersion: "fixture" };
  const [queued, failed] = await f.db.insert(aiRuns).values([
    { ...base, operationId: randomUUID(), status: "queued", createdAt: new Date(0) },
    { ...base, operationId: randomUUID(), status: "failed", createdAt: new Date(1) },
  ]).returning();
  await f.db.insert(aiRuns).values(Array.from({ length: 45 }, () => ({ ...base, operationId: randomUUID(), status: "done" as const, createdAt: now })));
  await f.db.insert(jobs).values([
    { userId: own.userId, type: "media_store", status: "queued", createdAt: new Date(0) },
    { userId: own.userId, type: "media_store", status: "failed", createdAt: new Date(1) },
    ...Array.from({ length: 45 }, () => ({ userId: own.userId, type: "media_store", status: "done", createdAt: now })),
  ]);
  const all = await (await f.app.request("/api/workspace/tasks", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(all.counts).toEqual({ active: 2, attention: 2, completed: 90 }); expect(all.items).toHaveLength(84); expect(all.truncated).toBe(true);
  expect(all.items.map(item => item.key)).toContain(`ai_run:${queued!.id}`); expect(all.items.map(item => item.key)).toContain(`ai_run:${failed!.id}`);
  expect(all.ranges.filter(range => range.bucket === "completed")).toEqual(expect.arrayContaining([
    { source: "ai_run", bucket: "completed", total: 45, returned: 40, truncated: true },
    { source: "job", bucket: "completed", total: 45, returned: 40, truncated: true },
  ]));
  const active = await (await f.app.request("/api/workspace/tasks?filter=active", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(active.items).toHaveLength(2); expect(active.items.every(item => item.bucket === "active")).toBe(true); expect(active.refreshAfterMs).toBe(5000);
  const attention = await (await f.app.request("/api/workspace/tasks?filter=attention", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(attention.items).toHaveLength(2); expect(attention.refreshAfterMs).toBeNull(); expect(attention.truncated).toBe(false);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000);
  await f.db.update(aiRuns).set({ nextAttemptAt: tomorrow }).where(eq(aiRuns.id, queued!.id));
  await f.db.update(jobs).set({ dueAt: tomorrow }).where(eq(jobs.status, "queued"));
  const future = await (await f.app.request("/api/workspace/tasks?filter=active", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(future.refreshAfterMs).toBe(30000); expect(future.items.every(item => item.state === "queued")).toBe(true);
  f.deps.now = () => tomorrow;
  const due = await (await f.app.request("/api/workspace/tasks?filter=active", authed(own.token))).json() as WorkspaceTasksResponse;
  expect(due.refreshAfterMs).toBe(5000);
});
