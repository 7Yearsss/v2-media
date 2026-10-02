import { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { BROWSER_EXECUTION_CAPABILITY as capability } from "@v2media/shared";
import { drizzle } from "drizzle-orm/pglite";

import { createApp } from "../src/app";
import type { Deps } from "../src/context";
import type { Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import type { AiClient } from "../src/modules/ai";
import { createAiRunHandlers } from "../src/lib/ai-run-handlers";
import { runAiJobs } from "../src/lib/ai-runs";

/** Tests advance the independently queued worker explicitly; requests never spawn work. */
export async function drainAiRuns(deps: Deps, limit = 20) {
  const handlers = createAiRunHandlers(deps);
  for (let n = 0; n < limit; n++) if (!await runAiJobs(deps, handlers)) return;
  throw new Error("AI test drain exceeded its bounded job limit");
}

export async function makeApp(ai?: AiClient) {
  const db = drizzle(new PGlite(), { schema }) as unknown as Db;
  await migrate(db);
  const deps: Deps = {
    db,
    ai: ai ?? { complete: async (_sys, user) => `标题：改写后的标题\n正文：改写后的正文 ${user.length}` },
    now: () => new Date(),
  };
  return { app: createApp(deps), db, deps };
}

export async function registerUser(app: ReturnType<typeof createApp>, email = "a@b.co") {
  const res = await app.request("/api/auth/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "hunter2x" }),
  });
  const body = (await res.json()) as any;
  if (!body.token) throw new Error(`register failed: ${res.status} ${JSON.stringify(body)}`);
  return { token: body.token as string, userId: body.user.id as number };
}

export function authed(token: string, init: RequestInit = {}): RequestInit {
  return {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  };
}

/** Simulates an editor reading its base version before an intentional text/account change. */
export async function editDraft(app: ReturnType<typeof createApp>, token: string, id: number, patch: object) {
  const current = await (await app.request(`/api/drafts/${id}`, authed(token))).json() as { textVersion: number };
  return app.request(`/api/drafts/${id}`, authed(token, { method: "PATCH", body: JSON.stringify({ textVersion: current.textVersion, ...patch }) }));
}

const testLeases = new WeakMap<object, Map<string, any>>();
/** Tests exercise the real capability-aware claim before reporting a result. */
export async function claimBrowser(app: ReturnType<typeof createApp>, token: string, domain: "publish" | "tasks", id: number, claimedBy = "sw-test") {
  const response = await app.request(`/api/ext/${domain}/${id}/claim`, authed(token, { method: "POST", body: JSON.stringify({ capability, claimedBy }) }));
  if (response.ok) {
    const leases = testLeases.get(app) ?? new Map(); testLeases.set(app, leases);
    leases.set(`${token}:${domain}:${id}`, await response.clone().json());
  }
  return response;
}
export function reportBrowser(app: ReturnType<typeof createApp>, token: string, domain: "publish" | "tasks", id: number, body: unknown) {
  const lease = testLeases.get(app)?.get(`${token}:${domain}:${id}`);
  if (!lease) throw new Error(`test must claim ${domain}:${id} first`);
  return app.request(`/api/ext/${domain}/${id}/result`, authed(token, { method: "POST", body: JSON.stringify({ capability, claimedBy: lease.claimedBy, leaseId: lease.leaseId, attempt: lease.attempt, receiptId: randomUUID(), ...(body as object) }) }));
}
