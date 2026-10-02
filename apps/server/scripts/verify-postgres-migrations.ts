/** Optional real-Postgres probe. Never uses DATABASE_URL or loads an .env file. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { Pool, type PoolClient } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Db } from "../src/db";
import { assertReadonlyRole } from "../src/db";
import { assertSchemaCurrent, duplicateAccountIdentities, migrate, migrationStatus, migrations } from "../src/db/migrate";
import * as schema from "../src/db/schema";

const fileFlag = process.argv.indexOf("--connection-file");
assert(fileFlag >= 0 && process.argv[fileFlag + 1] && process.argv.includes("--disposable"), "Usage: tsx apps/server/scripts/verify-postgres-migrations.ts --connection-file <fixture.json> --disposable");
const connection = JSON.parse(await readFile(process.argv[fileFlag + 1]!, "utf8")) as { url?: unknown };
assert.equal(typeof connection.url, "string", "connection file must supply url");
const target = new URL(connection.url as string);
assert(["postgresql:", "postgres:"].includes(target.protocol));
assert.equal(target.hostname, "127.0.0.1", "only the disposable loopback server is allowed");
assert.equal(target.port, "55437", "production/default database ports are prohibited");
assert.equal(target.pathname, "/v2media_r2_probe", "requires the dedicated disposable database");
assert.equal(target.username, "v2media_r2_probe", "requires the dedicated fixture role");
assert.equal(target.search, "", "connection overrides are prohibited");

const admin = new Pool({ connectionString: target.toString(), connectionTimeoutMillis: 3000, max: 4 });
const scenarioPools: Pool[] = [];
const runId = randomUUID().replaceAll("-", "");
const report: Record<string, unknown> = { scenarios: [] };
const scenarios = report.scenarios as Array<Record<string, unknown>>;

async function scenario(label: string) {
  const name = `r2_probe_${label}_${runId}`;
  assert(/^[a-z0-9_]+$/.test(name));
  await admin.query(`CREATE SCHEMA "${name}"`);
  const pool = new Pool({ connectionString: target.toString(), options: `-c search_path=${name}`, connectionTimeoutMillis: 3000, max: 4 });
  scenarioPools.push(pool);
  const db = drizzle(pool, { schema }) as unknown as Db;
  await migrate(db, { migrations: [migrations[0]!] });
  await pool.query("INSERT INTO users (email,password_hash) VALUES ('r2-probe@fixture.invalid','fixture-only')");
  await pool.query("INSERT INTO hosted_accounts (user_id,xhs_user_id,nickname,sub_type,positioning) VALUES (1,'same-identity','历史账号','creator','历史定位')");
  await pool.query("INSERT INTO drafts (user_id,title,content) VALUES (1,'历史正文','历史内容')");
  await pool.query("INSERT INTO publish_jobs (user_id,draft_id,account_id,status,note_id) VALUES (1,1,1,'done','history-note')");
  await pool.query("INSERT INTO note_metrics (user_id,publish_job_id,note_id,likes) VALUES (1,1,'history-note',0)");
  return { name, pool, db };
}

async function snapshot(client: Pool | PoolClient) {
  const accounts = (await client.query("SELECT id,user_id,platform,sub_type,xhs_user_id,nickname,positioning FROM hosted_accounts ORDER BY id")).rows;
  const drafts = (await client.query("SELECT id,user_id,title,content,status FROM drafts ORDER BY id")).rows;
  const publications = (await client.query("SELECT id,user_id,draft_id,account_id,status,note_id FROM publish_jobs ORDER BY id")).rows;
  const metrics = (await client.query("SELECT id,user_id,publish_job_id,note_id,likes FROM note_metrics ORDER BY id")).rows;
  const ledger = (await client.query("SELECT version,name,checksum,applied_at FROM schema_migrations ORDER BY version")).rows;
  const archivedColumn = (await client.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hosted_accounts' AND column_name='archived_at') AS present")).rows[0].present;
  return { accounts, drafts, publications, metrics, ledger, archivedColumn };
}

try {
  report.version = (await admin.query("SHOW server_version")).rows[0].server_version;
  const f = await scenario("locks"), before = await snapshot(f.pool);
  const blocker = await f.pool.connect(), contender = await f.pool.connect();
  let held = false;
  try {
    const blockerPid = (await blocker.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const contenderPid = (await contender.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    assert.notEqual(blockerPid, contenderPid, "requires two actual PostgreSQL backends");
    await blocker.query("BEGIN"); held = true;
    await blocker.query("SELECT pg_advisory_xact_lock(1446149476,2)");
    const contenderDb = drizzle(contender, { schema }) as unknown as Db;
    const start = performance.now();
    await assert.rejects(migrate(contenderDb, { lockTimeoutMs: 100 }), (error: any) => error.code === "55P03");
    const elapsedMs = Math.round(performance.now() - start);
    assert.deepEqual(await snapshot(contender), before, "lock timeout must not change ledger, DDL or business rows");
    await blocker.query("COMMIT"); held = false;
    await migrate(contenderDb, { lockTimeoutMs: 1000 });
    await assertSchemaCurrent(contenderDb);
    const after = await snapshot(contender);
    assert.deepEqual({ ...after, ledger: before.ledger, archivedColumn: before.archivedColumn }, before, "successful migration preserves business evidence");
    assert.deepEqual(after.ledger.map(row => row.version), migrations.map(row => row.version));
    assert.equal(after.archivedColumn, true);
    scenarios.push({ name: "two-backend lock timeout and retry", blockerPid, contenderPid, elapsedMs, timeoutSqlState: "55P03", ledgerUnchangedOnTimeout: true, businessRowsPreserved: true });
  } finally {
    if (held) await blocker.query("ROLLBACK");
    blocker.release(); contender.release();
  }

  const legacy = await scenario("duplicates");
  await legacy.pool.query("INSERT INTO hosted_accounts (user_id,xhs_user_id,nickname,sub_type,positioning) VALUES (1,'same-identity','另一个历史账号','creator','另一历史人设')");
  const duplicateBefore = await snapshot(legacy.pool);
  const problems = await duplicateAccountIdentities(legacy.db);
  assert.deepEqual(problems.map(p => p.ids), [[1, 2]]);
  await assert.rejects(migrate(legacy.db), /duplicate hosted account identities block migration/);
  assert.deepEqual(await snapshot(legacy.pool), duplicateBefore, "preflight must retain both identities, personas and publication evidence");
  assert.deepEqual((await migrationStatus(legacy.db)).applied.map(m => m.version), [1]);
  scenarios.push({ name: "legacy duplicate preflight", preservedIdentityIds: [1, 2], ledgerUnchanged: true, businessRowsPreserved: true });

  const rollback = await scenario("rollback"), rollbackBefore = await snapshot(rollback.pool);
  await assert.rejects(migrate(rollback.db, { migrations: [migrations[0]!, { version: 2, name: "fault-injection", statements: "ALTER TABLE hosted_accounts ADD COLUMN fault_probe text; SELECT r2_probe_missing_function()" }] }), (error: any) => error.code === "42883");
  assert.deepEqual(await snapshot(rollback.pool), rollbackBefore);
  assert.equal((await rollback.pool.query("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='hosted_accounts' AND column_name='fault_probe') AS present")).rows[0].present, false);
  scenarios.push({ name: "late DDL failure rollback", failureSqlState: "42883", ddlRolledBack: true, ledgerUnchanged: true, businessRowsPreserved: true });

  const readonlyName = `r2_probe_reader_${runId}`, readonlyPassword = randomUUID();
  await admin.query(`CREATE ROLE "${readonlyName}" LOGIN PASSWORD '${readonlyPassword}'`);
  await admin.query(`GRANT CONNECT ON DATABASE v2media_r2_probe TO "${readonlyName}"`);
  await admin.query(`GRANT USAGE ON SCHEMA "${f.name}" TO "${readonlyName}"`);
  await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA "${f.name}" TO "${readonlyName}"`);
  const readonlyUrl = new URL(target); readonlyUrl.username = readonlyName; readonlyUrl.password = readonlyPassword;
  const reader = new Pool({ connectionString: readonlyUrl.toString(), options: `-c search_path=${f.name} -c default_transaction_read_only=on`, connectionTimeoutMillis: 3000, max: 1 });
  scenarioPools.push(reader);
  const readonlyDb = drizzle(reader, { schema }) as unknown as Db;
  await assertReadonlyRole(readonlyDb);
  await assert.rejects(reader.query("UPDATE hosted_accounts SET nickname='forbidden' WHERE id=1"), (error: any) => error.code === "25006");
  await reader.query("SET default_transaction_read_only=off");
  await assert.rejects(reader.query("UPDATE hosted_accounts SET nickname='forbidden' WHERE id=1"), (error: any) => error.code === "42501");
  await reader.query("SET default_transaction_read_only=on");
  await admin.query(`GRANT UPDATE (nickname) ON "${f.name}".hosted_accounts TO "${readonlyName}"`);
  await assert.rejects(assertReadonlyRole(readonlyDb), /dedicated PostgreSQL role/);
  await admin.query(`REVOKE UPDATE (nickname) ON "${f.name}".hosted_accounts FROM "${readonlyName}"`);
  await assertReadonlyRole(readonlyDb);
  scenarios.push({ name: "real read-only grants and connection guard", sessionWriteSqlState: "25006", roleWriteSqlState: "42501", columnWriteGrantRejected: true });

  const deceptiveSchema = `pgx_probe_${runId}`;
  await admin.query(`CREATE SCHEMA "${deceptiveSchema}" AUTHORIZATION "${readonlyName}"`);
  await assert.rejects(assertReadonlyRole(readonlyDb), /dedicated PostgreSQL role/);
  await admin.query(`DROP SCHEMA "${deceptiveSchema}"`);
  await assertReadonlyRole(readonlyDb);
  scenarios.push({ name: "exact system schema prefix", userSchemaPrefix: "pgx_probe_", userSchemaOwnershipRejected: true });

  console.log(JSON.stringify({ ...report, ok: true }, null, 2));
} finally {
  await Promise.all(scenarioPools.map(pool => pool.end()));
  await admin.end();
}
