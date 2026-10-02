import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../src/app";
import type { Deps } from "../src/context";
import { assertReadonlyRole, createDb, postgresConnectionOptions, type Db } from "../src/db";
import { assertSchemaCurrent, duplicateAccountIdentities, migrate, migrationChecksum, migrationStatus, migrations, EXPECTED_SCHEMA_VERSION } from "../src/db/migrate";
import * as schema from "../src/db/schema";
import { runDraftJobs, startDraftWorker } from "../src/lib/draft-jobs";
import { runMediaJobs, startMediaWorker } from "../src/lib/media-jobs";
import { runPostmortemJobs, startPostmortemWorker } from "../src/lib/postmortem-jobs";
import { runUploadJobs, startUploadWorker, sweepUploadSources } from "../src/lib/upload-jobs";
import { pruneMedia, sweepMediaBacklog } from "../src/lib/media-store";
import { runtimeMode, validateRuntimeConfig } from "../src/runtime";
import { authed, makeApp, registerUser } from "./helpers";

const config = { runtimeMode: "production-worker" as const, databaseUrl: "postgres://user:pass@127.0.0.1:1/never-connect", authSecret: "a".repeat(32), encryptionKey: "b".repeat(64) };
const rows = async (db: Db, query: ReturnType<typeof sql>) => (await db.execute(query) as { rows: any[] }).rows;
const memory = () => drizzle(new PGlite(), { schema }) as unknown as Db;

describe("explicit runtime policy", () => {
  it("local default refuses a production URL before creating a connection, production secrets fail closed", async () => {
    expect(runtimeMode(undefined)).toBe("local-isolated");
    expect(() => runtimeMode("prod")).toThrow("V2MEDIA_RUNTIME_MODE");
    await expect(createDb({ ...config, runtimeMode: "local-isolated", dataDir: "never-create-r2-runtime-test" })).rejects.toThrow("refuses DATABASE_URL");
    expect(() => validateRuntimeConfig({ ...config, authSecret: "dev-only-secret" })).toThrow("AUTH_SECRET");
    expect(() => validateRuntimeConfig({ ...config, encryptionKey: "" })).toThrow("ENCRYPTION_KEY");
    expect(() => validateRuntimeConfig({ ...config, databaseUrl: "" })).toThrow("DATABASE_URL");
    expect(() => validateRuntimeConfig({ ...config, runtimeMode: "production-readonly", encryptionKey: "" })).not.toThrow();
    const options = postgresConnectionOptions({ ...config, runtimeMode: "production-readonly", databaseUrl: config.databaseUrl + "?options=-c%20default_transaction_read_only%3Doff" });
    expect(new URL(options.connectionString).searchParams.get("options")).toBe("-c default_transaction_read_only=on");
    const local = { ...config, runtimeMode: "local-isolated" as const, databaseUrl: "", r2Configured: true, r2Bucket: "v2-media", localR2Bucket: "v2-media" };
    expect(() => validateRuntimeConfig(local)).toThrow("production v2-media bucket");
    expect(() => validateRuntimeConfig({ ...local, r2Bucket: "isolated-r2" })).toThrow("LOCAL_R2_BUCKET");
    expect(() => validateRuntimeConfig({ ...local, r2Bucket: "isolated-r2", localR2Bucket: "isolated-r2" })).not.toThrow();
  });

  it("readonly permits login and reads, forbids every mutation before database or external work", async () => {
    const f = await makeApp(); const user = await registerUser(f.app);
    const app = createApp({ ...f.deps, runtimeMode: "production-readonly" });
    const login = await app.request("/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email: "a@b.co", password: "hunter2x" }) });
    expect(login.status).toBe(200);
    for (const [method, path] of [["POST", "/api/auth/register"], ["POST", "/api/ext/heartbeat"], ["POST", "/api/ext/collect"], ["POST", "/api/ext/publish/1/claim"], ["POST", "/api/ext/tasks/1/result"], ["PATCH", "/api/drafts/1"], ["DELETE", "/api/accounts/1"], ["POST", "/api/collections/1/analyze"], ["POST", "/api/ai/postmortem"], ["POST", "/api/media/upload"]]) {
      const response = await app.request(path!, authed(user.token, { method, body: "{}" }));
      expect(response.status, `${method} ${path}`).toBe(403); expect(await response.json()).toMatchObject({ code: "runtime_readonly" });
    }
    expect((await app.request("/api/drafts", authed(user.token))).status).toBe(200);
    expect(await (await app.request("/health")).json()).toMatchObject({ runtimeMode: "production-readonly", schemaVersion: EXPECTED_SCHEMA_VERSION });
    expect(await (await app.request("/api/runtime")).json()).toMatchObject({ runtimeMode: "production-readonly", schemaVersion: EXPECTED_SCHEMA_VERSION });
  });

  it("readonly stale observation does not persist status or reap attribution leases", async () => {
    const f = await makeApp(); const user = await registerUser(f.app);
    const [collection] = await f.db.insert(schema.collections).values({ userId: user.userId, name: "readonly" }).returning();
    const [analysis] = await f.db.insert(schema.collectionAnalyses).values({ userId: user.userId, collectionId: collection!.id, status: "running", data: {} as any, createdAt: new Date(Date.now() - 30 * 60_000) }).returning();
    const [account] = await f.db.insert(schema.hostedAccounts).values({ userId: user.userId, xhsUserId: "readonly-id", status: "online", lastSeenAt: new Date(0) }).returning();
    const [job] = await f.db.insert(schema.jobs).values({ userId: user.userId, type: "account_snapshot", status: "running", payload: { accountId: account!.id, xhsUserId: account!.xhsUserId }, leaseUntil: new Date(0), leaseId: "old-lease", claimedBy: "old-worker" }).returning();
    const app = createApp({ ...f.deps, runtimeMode: "production-readonly" });
    const detail = await (await app.request(`/api/collections/${collection!.id}/analyses/${analysis!.id}`, authed(user.token))).json() as any;
    expect(detail.status).toBe("failed");
    expect((await (await app.request("/api/accounts", authed(user.token))).json() as any[])[0].status).toBe("stale");
    expect((await app.request("/api/ext/tasks/pending", authed(user.token))).status).toBe(200);
    expect((await f.db.select().from(schema.collectionAnalyses))[0]!.status).toBe("running");
    expect((await f.db.select().from(schema.hostedAccounts))[0]!.status).toBe("online");
    expect((await f.db.select().from(schema.jobs).where(eq(schema.jobs.id, job!.id)))[0]).toMatchObject({ status: "running", claimedBy: "old-worker", leaseId: "old-lease" });
  });

  it("all worker and maintenance entry points are noops even if called directly", async () => {
    const fail = vi.fn(() => { throw new Error("readonly touched database/network"); });
    const deps = { runtimeMode: "production-readonly", db: new Proxy({}, { get: fail }), r2: new Proxy({}, { get: fail }), ai: { complete: fail }, now: fail } as unknown as Deps;
    for (const run of [runDraftJobs, runMediaJobs, runPostmortemJobs, runUploadJobs, sweepUploadSources, pruneMedia, sweepMediaBacklog]) await run(deps);
    for (const start of [startDraftWorker, startMediaWorker, startPostmortemWorker, startUploadWorker]) expect(start(deps)).toBeUndefined();
    expect(fail).not.toHaveBeenCalled();
  });

  it("effective PostgreSQL role grants reject owners and write grants; SELECT-only role cannot write", async () => {
    const db = memory(); await migrate(db);
    await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role");
    await db.execute(sql`SET default_transaction_read_only=off`);
    await db.execute(sql`CREATE ROLE r2_readonly NOINHERIT`);
    await db.execute(sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO r2_readonly`);
    await db.execute(sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO r2_readonly`);
    await db.execute(sql`SET ROLE r2_readonly`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).resolves.toBeUndefined(); await expect(assertSchemaCurrent(db)).resolves.toMatchObject({ expectedVersion: EXPECTED_SCHEMA_VERSION });
    await expect(db.execute(sql`UPDATE users SET email='blocked'`)).rejects.toThrow();
    await db.execute(sql`SET default_transaction_read_only=off`);
    await expect(db.execute(sql`UPDATE users SET email='still-blocked'`)).rejects.toThrow();
    await db.execute(sql`RESET ROLE`);
    await db.execute(sql`GRANT UPDATE ON users TO r2_readonly`);
    await db.execute(sql`SET ROLE r2_readonly`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role");
    await db.execute(sql`SET default_transaction_read_only=off`); await db.execute(sql`RESET ROLE`);
    await db.execute(sql`REVOKE UPDATE ON users FROM r2_readonly`); await db.execute(sql`GRANT UPDATE(email) ON users TO r2_readonly`);
    await db.execute(sql`SET ROLE r2_readonly`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role");
  });

  it("NOINHERIT membership cannot hide a writable SET ROLE target or SECURITY DEFINER function", async () => {
    const db = memory(); await migrate(db);
    await db.execute(sql`CREATE ROLE r2_reader NOINHERIT`); await db.execute(sql`CREATE ROLE r2_writer`); await db.execute(sql`CREATE ROLE r2_select_group`);
    await db.execute(sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO r2_select_group`); await db.execute(sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO r2_select_group`);
    await db.execute(sql`GRANT r2_select_group TO r2_reader`); await db.execute(sql`SET ROLE r2_reader`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).resolves.toBeUndefined(); await db.execute(sql`SET default_transaction_read_only=off`); await db.execute(sql`RESET ROLE`);
    await db.execute(sql`GRANT UPDATE ON users TO r2_writer`); await db.execute(sql`GRANT r2_writer TO r2_reader`);
    await db.execute(sql`SET ROLE r2_reader`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role"); await db.execute(sql`SET default_transaction_read_only=off`); await db.execute(sql`RESET ROLE`);
    await db.execute(sql`REVOKE r2_writer FROM r2_reader`);
    await db.execute(sql`CREATE FUNCTION r2_privileged_probe() RETURNS integer LANGUAGE SQL SECURITY DEFINER AS 'SELECT 1'`);
    await db.execute(sql`SET ROLE r2_reader`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role");
  });

  it("pgx user schemas remain subject to ownership and column-write checks", async () => {
    const db = memory(); await migrate(db);
    await db.execute(sql`CREATE ROLE r2_pgx_reader NOINHERIT`); await db.execute(sql`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
    await db.execute(sql`GRANT USAGE ON SCHEMA public TO r2_pgx_reader`); await db.execute(sql`GRANT SELECT ON ALL TABLES IN SCHEMA public TO r2_pgx_reader`);
    await db.execute(sql`SET ROLE r2_pgx_reader`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).resolves.toBeUndefined(); await db.execute(sql`SET default_transaction_read_only=off`); await db.execute(sql`RESET ROLE`);
    await db.execute(sql`CREATE SCHEMA pgx_owned AUTHORIZATION r2_pgx_reader`);
    await db.execute(sql`SET ROLE r2_pgx_reader`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role"); await db.execute(sql`SET default_transaction_read_only=off`); await db.execute(sql`RESET ROLE`);
    await db.execute(sql`ALTER SCHEMA pgx_owned OWNER TO postgres`); await db.execute(sql`REVOKE ALL ON SCHEMA pgx_owned FROM r2_pgx_reader`);
    await db.execute(sql`GRANT USAGE ON SCHEMA pgx_owned TO r2_pgx_reader`); await db.execute(sql`CREATE TABLE pgx_owned.probe(id integer)`);
    await db.execute(sql`GRANT UPDATE(id) ON pgx_owned.probe TO r2_pgx_reader`);
    await db.execute(sql`SET ROLE r2_pgx_reader`); await db.execute(sql`SET default_transaction_read_only=on`);
    await expect(assertReadonlyRole(db)).rejects.toThrow("dedicated PostgreSQL role");
  });
});

describe("versioned schema migrations", () => {
  it("fresh bootstrap applies exactly once, status/startup perform no DDL and detect corruption", async () => {
    expect(migrationChecksum({ ...migrations[0]!, statements: migrations[0]!.statements.replace(/\n/g, "\r\n") })).toBe(migrationChecksum(migrations[0]!));
    const db = memory(); expect((await migrationStatus(db)).applied).toHaveLength(0);
    await expect(assertSchemaCurrent(db)).rejects.toThrow("explicit db:migrate"); await migrate(db);
    const before = await migrationStatus(db); await migrate(db); expect(await migrationStatus(db)).toEqual(before);
    expect((await assertSchemaCurrent(db)).applied).toHaveLength(migrations.length);
    await db.execute(sql`UPDATE schema_migrations SET checksum='wrong' WHERE version=1`);
    await expect(assertSchemaCurrent(db)).rejects.toThrow("ledger mismatch"); await expect(migrate(db)).rejects.toThrow("ledger mismatch");
  });

  it("missing physical schema cannot hide behind a valid ledger", async () => {
    const db = memory(); await migrate(db); await db.execute(sql`ALTER TABLE drafts DROP COLUMN archived_at`);
    await expect(assertSchemaCurrent(db)).rejects.toThrow("schema column missing: drafts.archived_at");
  });

  it("durable AI migration preserves legacy running evidence and verifies operation fences", async () => {
    const db = memory(); await migrate(db, { migrations: migrations.slice(0, 2) });
    await db.execute(sql`INSERT INTO users(id,email,password_hash) VALUES(1,'ai-legacy@isolated.test','hash')`);
    await db.execute(sql`INSERT INTO hosted_accounts(id,user_id,xhs_user_id) VALUES(1,1,'ai-legacy')`);
    await db.execute(sql`INSERT INTO collections(id,user_id,name) VALUES(1,1,'legacy source')`);
    await db.execute(sql`INSERT INTO collection_analyses(id,user_id,collection_id,status,data,report) VALUES(1,1,1,'running','{}','legacy evidence')`);
    const before = await rows(db, sql`SELECT id,user_id,collection_id,status,data,report,created_at FROM collection_analyses`);
    await migrate(db); await assertSchemaCurrent(db);
    expect(await rows(db, sql`SELECT id,user_id,collection_id,status,data,report,created_at FROM collection_analyses`)).toEqual(before);
    expect(await rows(db, sql`SELECT ai_run_id FROM collection_analyses`)).toEqual([{ ai_run_id: null }]);
    expect(await rows(db, sql`SELECT execution_revision FROM hosted_accounts`)).toEqual([{ execution_revision: 0 }]);
    expect(await rows(db, sql`SELECT id FROM ai_runs`)).toEqual([]);
    await db.execute(sql`DROP INDEX ai_run_commands_user_operation`);
    await expect(assertSchemaCurrent(db)).rejects.toThrow("AI operation constraints");
  });

  it("legacy upgrade preserves publication, metric and account evidence and changes only schema", async () => {
    const db = memory();
    for (const statement of migrations[0]!.statements.split(";").map(s => s.trim()).filter(Boolean)) await db.execute(sql.raw(statement));
    await db.execute(sql`INSERT INTO users(id,email,password_hash) VALUES(5,'legacy@isolated.test','hash')`);
    await db.execute(sql`INSERT INTO hosted_accounts(id,user_id,xhs_user_id,nickname) VALUES(7,5,'legacy-id','legacy nickname')`);
    await db.execute(sql`INSERT INTO drafts(id,user_id,title) VALUES(9,5,'legacy title')`);
    await db.execute(sql`INSERT INTO publish_jobs(id,user_id,draft_id,account_id,status,note_id) VALUES(11,5,9,7,'done','legacy-note')`);
    await db.execute(sql`INSERT INTO note_metrics(user_id,publish_job_id,note_id,likes) VALUES(5,11,'legacy-note',8)`);
    await migrate(db); await assertSchemaCurrent(db);
    expect(await rows(db, sql`SELECT id, status, note_id, draft_snapshot, account_snapshot FROM publish_jobs`)).toEqual([{ id: 11, status: "done", note_id: "legacy-note", draft_snapshot: null, account_snapshot: null }]);
    expect((await rows(db, sql`SELECT publish_job_id,likes FROM note_metrics`))[0]).toEqual({ publish_job_id: 11, likes: 8 });
    expect((await rows(db, sql`SELECT archived_at FROM hosted_accounts`))[0].archived_at).toBeNull();
  });

  it("duplicate and noncanonical legacy identities block atomically, retain all old IDs", async () => {
    const db = memory(); await migrate(db, { migrations: [migrations[0]!] });
    await db.execute(sql`INSERT INTO users(id,email,password_hash) VALUES(1,'legacy@isolated.test','hash')`);
    await db.execute(sql`INSERT INTO hosted_accounts(user_id,xhs_user_id) VALUES(1,'duplicate'),(1,'duplicate'),(1,E'\\ttrimmed\\t'),(1,'')`);
    const before = await rows(db, sql`SELECT id,xhs_user_id FROM hosted_accounts ORDER BY id`);
    expect(await duplicateAccountIdentities(db)).toHaveLength(3);
    await expect(migrate(db)).rejects.toThrow("identities block migration"); expect(await rows(db, sql`SELECT id,xhs_user_id FROM hosted_accounts ORDER BY id`)).toEqual(before);
    expect((await migrationStatus(db)).applied).toHaveLength(1);
    expect(await rows(db, sql`SELECT column_name FROM information_schema.columns WHERE table_name='hosted_accounts' AND column_name='archived_at'`)).toHaveLength(0);
  });

  it("failed statement rolls schema and ledger back together; readonly cannot migrate", async () => {
    const db = memory(); await migrate(db);
    await expect(migrate(db, { migrations: [...migrations, { version: EXPECTED_SCHEMA_VERSION + 1, name: "failure-probe", statements: "CREATE TABLE r2_failure_probe(id integer); SELECT missing_r2_probe_function();" }] })).rejects.toThrow();
    expect(await rows(db, sql`SELECT table_name FROM information_schema.tables WHERE table_name='r2_failure_probe'`)).toHaveLength(0);
    expect((await migrationStatus(db)).applied).toHaveLength(migrations.length);
    await expect(migrate(db, { runtimeMode: "production-readonly" })).rejects.toThrow("refuses schema migrations");
  });
});
