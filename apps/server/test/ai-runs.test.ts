import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Deps } from "../src/context";
import type { Db } from "../src/db";
import { migrate } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { aiRuns, collections, topics, users } from "../src/db/schema";
import { AI_RUN_LEASE_MS, AiRunConflict, AiRunError, AiRunObsolete, aiRunView, cancelAiRun, claimAiRun, enqueueAiRun,
  findAiRunOperation, recoverAiRuns, renewAiRunLease, retryAiRun, runAiJobs, startAiWorker, type AiRunControls, type AiRunHandler, type AiRunHandlers } from "../src/lib/ai-runs";

const clients: PGlite[] = [];
afterEach(async () => { for (const client of clients.splice(0)) await client.close(); });

async function fixture() {
  const client = new PGlite(); clients.push(client);
  const db = drizzle(client, { schema }) as unknown as Db; await migrate(db);
  const [owned] = await db.insert(users).values({ email: "ai-core@fixture.invalid", passwordHash: "offline-fixture" }).returning();
  const user = { userId: owned!.id };
  const [collection] = await db.insert(collections).values({ userId: user.userId, name: "durable snapshots" }).returning();
  let now = new Date("2026-10-02T04:00:00Z");
  const deps: Deps = { db, now: () => now, ai: { complete: async () => { throw new Error("core tests never call AI"); } } };
  const input = { secret: "xsec_token-never-public", title: "frozen topic", model: "frozen-model" };
  const enqueue = (operationId = randomUUID(), request: unknown = { collectionId: collection!.id, count: 1 }, snapshot: unknown = input) => db.transaction(tx => enqueueAiRun(tx as unknown as Db, {
    userId: user.userId, operationId, kind: "topic_generate", targetType: "collection", targetId: collection!.id,
    request, input: snapshot, model: "frozen-model", promptVersion: "frozen-v1", now,
  }));
  const handler: AiRunHandler = {
    execute: async (run, controls) => { await controls.progress("generating", ["generating", "saving"]); return (run.frozenInput as typeof input).title; },
    apply: async (tx, run, output) => {
      const [topic] = await tx.insert(topics).values({ userId: run.userId, collectionId: collection!.id, title: String(output), sourceType: "ai" }).returning();
      return { collectionId: collection!.id, topicIds: [topic!.id], count: 1 };
    },
  };
  const handlers: AiRunHandlers = { topic_generate: handler };
  return { db, deps, user, collection: collection!, input, enqueue, handler, handlers,
    advance(ms: number) { now = new Date(now.getTime() + ms); },
    async row(id: number) { return (await db.select().from(aiRuns).where(eq(aiRuns.id, id)))[0]!; },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

describe("durable AI execution", () => {
  it("operation replay uses original request and snapshot, with a per-user cross-kind conflict fence", async () => {
    const f = await fixture(); const operationId = randomUUID();
    const first = await f.enqueue(operationId, { count: 1, collectionId: f.collection.id });
    const replay = await f.enqueue(operationId, { collectionId: f.collection.id, count: 1 }, { title: "new mutable source" });
    expect(replay.id).toBe(first.id); expect(replay.frozenInput).toEqual(f.input);
    await expect(f.enqueue(operationId, { collectionId: f.collection.id, count: 2 })).rejects.toBeInstanceOf(AiRunConflict);
    await expect(f.db.transaction(tx => findAiRunOperation(tx as unknown as Db, f.user.userId, operationId, "topic_score", { count: 1, collectionId: f.collection.id }))).rejects.toBeInstanceOf(AiRunConflict);
    expect(await f.db.select().from(aiRuns)).toHaveLength(1);
  });

  it("queued work survives creation scope and commits one result with frozen metadata", async () => {
    const f = await fixture(); const run = await f.enqueue();
    expect(run.status).toBe("queued"); expect(await f.db.select().from(topics)).toHaveLength(0);
    const inspect = vi.fn(f.handler.execute); f.handler.execute = inspect;
    expect(await runAiJobs({ ...f.deps }, f.handlers)).toBe(true);
    expect(inspect.mock.calls[0]![0]).toMatchObject({ frozenInput: f.input, model: "frozen-model", promptVersion: "frozen-v1", attempt: 1 });
    const done = await f.row(run.id); expect(done).toMatchObject({ status: "done", stage: "done", leaseId: null, attempt: 1 });
    expect(await runAiJobs(f.deps, f.handlers)).toBe(false);
    expect(await f.db.select().from(topics)).toHaveLength(1);
    expect(JSON.stringify(aiRunView(done))).not.toContain("xsec_token");
  });

  it("duplicate simultaneous operations create only one persistent execution", async () => {
    const f = await fixture(); const operationId = randomUUID();
    const [a, b] = await Promise.all([f.enqueue(operationId), f.enqueue(operationId)]);
    expect(a.id).toBe(b.id); expect(await f.db.select().from(aiRuns)).toHaveLength(1);
  });

  it("a failed terminal transaction rolls domain writes back, then a new attempt commits once", async () => {
    const f = await fixture(); const run = await f.enqueue(); const original = f.handler.apply;
    f.handler.apply = async (tx, row, result) => { await original(tx, row, result); await tx.execute(sql`SELECT missing_ai_commit_probe()`); return null; };
    await runAiJobs(f.deps, f.handlers);
    expect(await f.db.select().from(topics)).toHaveLength(0); expect(await f.row(run.id)).toMatchObject({ status: "queued", attempt: 1, stage: "retry_wait" });
    f.handler.apply = original; f.advance(30_001); await runAiJobs(f.deps, f.handlers);
    expect(await f.row(run.id)).toMatchObject({ status: "done", attempt: 2 }); expect(await f.db.select().from(topics)).toHaveLength(1);
  });

  it("a lost commit acknowledgement preserves the already committed result without another model call", async () => {
    const f = await fixture(); const run = await f.enqueue(); let transactions = 0;
    const db = new Proxy(f.db, { get(target, property) {
      if (property === "transaction") return async (...args: Parameters<Db["transaction"]>) => {
        const result = await target.transaction(...args);
        if (++transactions === 2) throw new Error("transport acknowledgement lost after COMMIT");
        return result;
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const execute = vi.fn(f.handler.execute); f.handler.execute = execute;
    await runAiJobs({ ...f.deps, db }, f.handlers);
    expect(await f.row(run.id)).toMatchObject({ status: "done", attempt: 1 });
    expect(await runAiJobs(f.deps, f.handlers)).toBe(false); expect(execute).toHaveBeenCalledTimes(1);
    expect(await f.db.select().from(topics)).toHaveLength(1);
  });

  it("lease recovery fences late progress and late model results from an earlier attempt", async () => {
    const f = await fixture(); const run = await f.enqueue();
    const waiting = deferred<string>(); const started = deferred<AiRunControls>();
    f.handler.execute = async (row, controls) => { if (row.attempt === 1) { started.resolve(controls); return waiting.promise; } return "recovered result"; };
    const oldWorker = runAiJobs(f.deps, f.handlers); const oldControls = await started.promise;
    f.advance(AI_RUN_LEASE_MS + 1); await recoverAiRuns(f.deps, f.handlers);
    expect(await f.row(run.id)).toMatchObject({ status: "queued", attempt: 1 });
    f.advance(30_001); await runAiJobs(f.deps, f.handlers);
    await expect(oldControls.progress("late-stage")).rejects.toBeInstanceOf(AiRunObsolete);
    await expect(oldControls.assertActive()).rejects.toBeInstanceOf(AiRunObsolete);
    waiting.resolve("obsolete result"); await oldWorker;
    expect(await f.row(run.id)).toMatchObject({ status: "done", attempt: 2, stage: "done" });
    expect((await f.db.select().from(topics)).map(topic => topic.title)).toEqual(["recovered result"]);
  });

  it("two workers cannot execute the same claimed generation", async () => {
    const f = await fixture(); await f.enqueue(); const waiting = deferred<string>(); const started = deferred<void>();
    const execute = vi.fn(async () => { started.resolve(); return waiting.promise; }); f.handler.execute = execute;
    const first = runAiJobs(f.deps, f.handlers); await started.promise;
    expect(await runAiJobs(f.deps, f.handlers)).toBe(false);
    waiting.resolve("only once"); await first;
    expect(execute).toHaveBeenCalledTimes(1); expect(await f.db.select().from(topics)).toHaveLength(1);
  });

  it("explicit cancellation persists before a pending model answer and cannot be revived", async () => {
    const f = await fixture(); const run = await f.enqueue(); const waiting = deferred<string>(); const started = deferred<AiRunControls>();
    f.handler.execute = async (_row, controls) => { started.resolve(controls); return waiting.promise; };
    const worker = runAiJobs(f.deps, f.handlers); const controls = await started.promise;
    expect((await cancelAiRun(f.deps, f.handlers, f.user.userId, run.id)).code).toBe(200);
    await expect(controls.progress("late-stage")).rejects.toBeInstanceOf(AiRunObsolete);
    waiting.resolve("late answer"); await worker;
    expect(await f.row(run.id)).toMatchObject({ status: "canceled", leaseId: null, errorCode: "canceled" });
    expect(await f.db.select().from(topics)).toHaveLength(0);
    expect((await retryAiRun(f.deps, f.handlers, f.user.userId, run.id)).code).toBe(409);
  });

  it("transient errors back off for three attempts and never expose provider raw errors", async () => {
    const f = await fixture(); const run = await f.enqueue(); const fail = vi.fn(async () => {}); f.handler.fail = fail;
    const execute = vi.fn(async () => { throw new Error("Bearer SECRET_FROM_PROVIDER raw request"); }); f.handler.execute = execute;
    await runAiJobs(f.deps, f.handlers);
    expect(await runAiJobs(f.deps, f.handlers)).toBe(false);
    f.advance(30_001); await runAiJobs(f.deps, f.handlers); f.advance(60_001); await runAiJobs(f.deps, f.handlers);
    expect(execute).toHaveBeenCalledTimes(3); expect(fail).toHaveBeenCalledTimes(1);
    const row = await f.row(run.id); expect(row).toMatchObject({ status: "failed", attempt: 3, errorCode: "ai_failed" });
    expect(JSON.stringify(aiRunView(row))).not.toMatch(/SECRET|Bearer|raw request/);
  });

  it("invalid output fails immediately and a deliberate retry preserves input and increments fencing", async () => {
    const f = await fixture(); const run = await f.enqueue();
    f.handler.execute = async () => { throw new AiRunError("invalid_output", "选题缺少完整七维评分"); };
    await runAiJobs(f.deps, f.handlers); expect(await f.row(run.id)).toMatchObject({ status: "failed", attempt: 1, errorCode: "invalid_output" });
    f.input.title = "changed after submission";
    const retry = await retryAiRun(f.deps, f.handlers, f.user.userId, run.id);
    expect(retry.code).toBe(202); expect(retry.run).toMatchObject({ attempt: 1, maxAttempts: 4, status: "queued", frozenInput: { title: "frozen topic" } });
    f.handler.execute = async row => (row.frozenInput as { title: string }).title;
    await runAiJobs(f.deps, f.handlers); expect(await f.row(run.id)).toMatchObject({ status: "done", attempt: 2 });
    expect((await f.db.select().from(topics))[0]!.title).toBe("frozen topic");
  });

  it("obsolete targets cancel before external work and cannot be manually retried", async () => {
    const f = await fixture(); const run = await f.enqueue(); const execute = vi.fn(f.handler.execute); f.handler.execute = execute; f.handler.check = async () => false;
    await runAiJobs(f.deps, f.handlers); expect(execute).not.toHaveBeenCalled(); expect(await f.row(run.id)).toMatchObject({ status: "canceled", attempt: 0, errorCode: "target_obsolete" });
    const another = await f.enqueue(); f.handler.check = async () => true; f.handler.execute = async () => { throw new AiRunError("invalid_output"); };
    await runAiJobs(f.deps, f.handlers); f.handler.check = async () => false;
    expect((await retryAiRun(f.deps, f.handlers, f.user.userId, another.id)).code).toBe(409);
    expect(await f.row(another.id)).toMatchObject({ status: "failed", attempt: 1 });
  });

  it("a target becoming obsolete during a live attempt is canceled without waiting for lease expiry", async () => {
    const f = await fixture(); const run = await f.enqueue(); let current = true;
    f.handler.check = async () => current;
    const cancel = vi.fn(async () => {}); f.handler.cancel = cancel;
    f.handler.execute = async () => { current = false; throw new AiRunObsolete(); };
    await runAiJobs(f.deps, f.handlers);
    expect(await f.row(run.id)).toMatchObject({ status: "canceled", attempt: 1, errorCode: "target_obsolete", leaseId: null });
    expect(cancel).toHaveBeenCalledTimes(1); expect(await f.db.select().from(topics)).toHaveLength(0);
  });

  it("a lost manual retry acknowledgement cannot cause another execution after the retry fails quickly", async () => {
    const f = await fixture(); const run = await f.enqueue(); const operationId = randomUUID();
    const execute = vi.fn(async () => { throw new AiRunError("invalid_output"); }); f.handler.execute = execute;
    await runAiJobs(f.deps, f.handlers);
    expect((await retryAiRun(f.deps, f.handlers, f.user.userId, run.id, operationId)).run?.status).toBe("queued");
    await runAiJobs(f.deps, f.handlers); expect(await f.row(run.id)).toMatchObject({ status: "failed", attempt: 2 });
    const replay = await retryAiRun(f.deps, f.handlers, f.user.userId, run.id, operationId);
    expect(replay.code).toBe(202); expect(replay.run).toMatchObject({ status: "failed", attempt: 2 });
    expect(await runAiJobs(f.deps, f.handlers)).toBe(false); expect(execute).toHaveBeenCalledTimes(2);
    const other = await f.enqueue();
    expect((await retryAiRun(f.deps, f.handlers, f.user.userId, other.id, operationId)).code).toBe(409);
  });

  it("a lease expiring inside result application rolls the entire domain transaction back", async () => {
    const f = await fixture(); const run = await f.enqueue(); const original = f.handler.apply;
    f.handler.apply = async (tx, row, result) => { const summary = await original(tx, row, result); f.advance(AI_RUN_LEASE_MS + 1); return summary; };
    await runAiJobs(f.deps, f.handlers);
    expect(await f.db.select().from(topics)).toHaveLength(0); expect(await f.row(run.id)).toMatchObject({ status: "running", result: null });
    await recoverAiRuns(f.deps, f.handlers); expect(await f.row(run.id)).toMatchObject({ status: "queued", stage: "retry_wait" });
  });

  it("readonly workers perform no DB, clock or AI access", async () => {
    const fail = vi.fn(() => { throw new Error("readonly touched dependency"); });
    const deps = { runtimeMode: "production-readonly", db: new Proxy({}, { get: fail }), ai: { complete: fail }, now: fail } as unknown as Deps;
    expect(await runAiJobs(deps, {})).toBe(false); expect(await claimAiRun(deps, {})).toBeNull(); await recoverAiRuns(deps, {});
    expect(await renewAiRunLease(deps, {} as any)).toBe(false); expect(startAiWorker(deps, {})).toBeUndefined();
    await expect(retryAiRun(deps, {}, 1, 1)).rejects.toThrow("production-readonly");
    await expect(cancelAiRun(deps, {}, 1, 1)).rejects.toThrow("production-readonly"); expect(fail).not.toHaveBeenCalled();
  });
});
