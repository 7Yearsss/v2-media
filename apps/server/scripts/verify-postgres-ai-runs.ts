/** Optional PostgreSQL execution probe; only the named disposable fixture is permitted. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../src/db";
import type { Deps } from "../src/context";
import { migrate } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { AiRunConflict, AiRunError, enqueueAiRun, recoverAiRuns, retryAiRun, runAiJobs, type AiRunHandler } from "../src/lib/ai-runs";

const flag = process.argv.indexOf("--connection-file");
assert(flag >= 0 && process.argv[flag + 1] && process.argv.includes("--disposable"), "Use --connection-file <fixture.json> --disposable");
const config = JSON.parse(await readFile(process.argv[flag + 1]!, "utf8")) as { url?: unknown };
assert.equal(typeof config.url, "string");
const target = new URL(config.url as string);
assert(["postgres:", "postgresql:"].includes(target.protocol));
assert.equal(target.hostname, "127.0.0.1"); assert.equal(target.port, "55437");
assert.equal(target.pathname, "/v2media_r2_probe"); assert.equal(target.username, "v2media_r2_probe"); assert.equal(target.search, "");
const schemaName = `r3_ai_probe_${randomUUID().replaceAll("-", "")}`;
assert(/^r3_ai_probe_[a-f0-9]{32}$/.test(schemaName));
const admin = new Pool({ connectionString: target.toString(), max: 1, connectionTimeoutMillis: 3000 });
const pool = new Pool({ connectionString: target.toString(), options: `-c search_path=${schemaName}`, max: 4, connectionTimeoutMillis: 3000 });
const db = drizzle(pool, { schema }) as unknown as Db;
let created = false;
const passed: string[] = [];
let now = new Date("2026-10-02T04:00:00Z");
const deps: Deps = { db, now: () => now, ai: { complete: async () => { throw new Error("probe never calls external AI"); } } };
const advance = (ms: number) => { now = new Date(now.getTime() + ms); };
const read = async (id: number) => (await db.select().from(schema.aiRuns).where(eq(schema.aiRuns.id, id)))[0]!;
const enqueue = (operationId: string, title: string) => db.transaction(tx => enqueueAiRun(tx as unknown as Db, {
  userId: 1, kind: "topic_generate", targetType: "collection", targetId: 1, operationId,
  request: { count: 1, collectionId: 1 }, input: { title }, model: "fixture-model", promptVersion: "fixture-v1", now,
}));
const handler: AiRunHandler = {
  execute: async run => (run.frozenInput as { title: string }).title,
  apply: async (tx, run, result) => {
    const [topic] = await tx.insert(schema.topics).values({ userId: run.userId, collectionId: 1, title: String(result) }).returning();
    return { collectionId: 1, topicIds: [topic!.id], count: 1 };
  },
};
try {
  await admin.query(`CREATE SCHEMA "${schemaName}"`); created = true;
  await migrate(db);
  await pool.query("INSERT INTO users(id,email,password_hash) VALUES(1,'ai-probe@fixture.invalid','fixture')");
  await pool.query("INSERT INTO collections(id,user_id,name) VALUES(1,1,'AI fixture')");
  const operationId = randomUUID();
  const [first, duplicate] = await Promise.all([enqueue(operationId, "original"), enqueue(operationId, "changed mutable input")]);
  assert.equal(first.id, duplicate.id); assert.deepEqual(first.frozenInput, duplicate.frozenInput);
  await assert.rejects(db.transaction(tx => enqueueAiRun(tx as unknown as Db, { userId: 1, kind: "topic_generate", targetType: "collection", targetId: 1,
    operationId, request: { count: 2, collectionId: 1 }, input: {}, model: "fixture", promptVersion: "fixture" })), AiRunConflict);
  passed.push("concurrent operation identity and frozen snapshot");

  let started!: () => void, finish!: (result: string) => void;
  const began = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<string>(resolve => { finish = resolve; });
  const originalExecute = handler.execute;
  handler.execute = async () => { started(); return pending; };
  const firstWorker = runAiJobs(deps, { topic_generate: handler }); await began;
  assert.equal(await runAiJobs(deps, { topic_generate: handler }), false);
  finish("one owned write"); await firstWorker; handler.execute = originalExecute;
  assert.equal((await read(first.id)).status, "done");
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM topics")).rows[0].count, 1);
  passed.push("independent workers claim once and terminal commit once");

  const rollback = await enqueue(randomUUID(), "rollback then recovery"); const apply = handler.apply;
  handler.apply = async (tx, run, result) => { await apply(tx, run, result); await tx.execute(sql`SELECT r3_missing_commit_probe()`); return null; };
  await runAiJobs(deps, { topic_generate: handler });
  assert.equal((await read(rollback.id)).status, "queued");
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM topics")).rows[0].count, 1);
  advance(30_001); handler.apply = apply; await runAiJobs(deps, { topic_generate: handler });
  assert.equal((await read(rollback.id)).attempt, 2); assert.equal((await read(rollback.id)).status, "done");
  assert.equal((await pool.query("SELECT count(*)::integer AS count FROM topics")).rows[0].count, 2);
  passed.push("domain write rollback and durable retry");

  const failed = await enqueue(randomUUID(), "invalid structured output");
  handler.execute = async () => { throw new AiRunError("invalid_output"); };
  await runAiJobs(deps, { topic_generate: handler }); const retryOperation = randomUUID();
  assert.equal((await retryAiRun(deps, { topic_generate: handler }, 1, failed.id, retryOperation)).run?.status, "queued");
  await runAiJobs(deps, { topic_generate: handler });
  assert.equal((await retryAiRun(deps, { topic_generate: handler }, 1, failed.id, retryOperation)).run?.status, "failed");
  assert.equal((await read(failed.id)).attempt, 2); assert.equal(await runAiJobs(deps, { topic_generate: handler }), false);
  passed.push("manual retry receipt survives lost acknowledgement and rapid failure");

  const expired = await enqueue(randomUUID(), "expired generation");
  // timestamp-without-timezone columns store UTC; native pg Date encoding follows the host timezone.
  await pool.query("UPDATE ai_runs SET status='running',attempt=1,lease_id=$1,lease_until=$2 WHERE id=$3", [randomUUID(), new Date(now.getTime() - 1).toISOString(), expired.id]);
  await recoverAiRuns(deps, { topic_generate: handler });
  assert.equal((await read(expired.id)).status, "queued"); assert.equal((await read(expired.id)).leaseId, null);
  passed.push("restart recovery fences an expired generation");
  console.log(JSON.stringify({ postgres: (await pool.query("SHOW server_version")).rows[0].server_version, scenarios: passed }, null, 2));
} finally {
  await pool.end();
  if (created) await admin.query(`DROP SCHEMA "${schemaName}" CASCADE`);
  await admin.end();
}
