import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import type { Db } from "../src/db";
import { aiRuns, collections } from "../src/db/schema";
import { AI_RUN_LEASE_MS, claimAiRun, enqueueAiRun } from "../src/lib/ai-runs";
import { authed, makeApp, registerUser } from "./helpers";

it("AI run reads are isolated, redact snapshots and never reap expired leases", async () => {
  const f = await makeApp(); const user = await registerUser(f.app);
  const [collection] = await f.db.insert(collections).values({ userId: user.userId, name: "private fixture" }).returning();
  let now = new Date("2026-10-02T04:00:00Z"); f.deps.now = () => now;
  const run = await f.db.transaction(tx => enqueueAiRun(tx as unknown as Db, { userId: user.userId, kind: "topic_generate", targetType: "collection", targetId: collection!.id,
    operationId: randomUUID(), request: { collectionId: collection!.id }, input: { private: "xsec_token-never-public" }, model: "fixture", promptVersion: "fixture", now }));
  const claimed = await claimAiRun(f.deps, { topic_generate: { execute: async () => null, apply: async () => null } }); expect(claimed?.id).toBe(run.id);
  now = new Date(now.getTime() + AI_RUN_LEASE_MS + 1);
  const response = await f.app.request(`/api/ai/runs/${run.id}`, authed(user.token));
  expect(response.status).toBe(200); const body = await response.json();
  expect(body).toMatchObject({ status: "running", attempt: 1 }); expect(JSON.stringify(body)).not.toMatch(/frozenInput|leaseId|requestHash|inputHash|xsec_token/);
  expect((await f.db.select().from(aiRuns).where(eq(aiRuns.id, run.id)))[0]).toMatchObject({ status: "running" });
  const other = await registerUser(f.app, "other-ai@isolated.test");
  expect((await f.app.request(`/api/ai/runs/${run.id}`, authed(other.token))).status).toBe(404);
  expect((await f.app.request(`/api/ai/runs/${run.id}/cancel`, authed(other.token, { method: "POST" }))).status).toBe(404);
  expect((await f.app.request(`/api/ai/runs?kind=invalid`, authed(user.token))).status).toBe(400);
  expect((await f.app.request(`/api/ai/runs/${run.id}/retry`, authed(user.token, { method: "POST", body: "{malformed" }))).status).toBe(400);
  expect((await f.app.request(`/api/ai/runs/${run.id}/retry`, authed(user.token, { method: "POST", body: JSON.stringify({ operationId: "bad-id" }) }))).status).toBe(400);
  expect((await (await f.app.request("/api/ai/runs", authed(other.token))).json()) as any).toEqual({ items: [] });
});
