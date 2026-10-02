import { createHash } from "node:crypto";
import { getTableColumns, getTableName, is, sql } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import type { RuntimeMode } from "../runtime";
import type { Db } from "./index";
import { LEGACY_DDL } from "./migrations/0001-legacy";
import * as schema from "./schema";

export interface SchemaMigration { version: number; name: string; statements: string; backfillWritingAccount?: boolean }
export const migrations: readonly SchemaMigration[] = [
  { version: 1, name: "legacy-bootstrap", statements: LEGACY_DDL, backfillWritingAccount: true },
  { version: 2, name: "history-account-identity", statements: `
    ALTER TABLE hosted_accounts ADD COLUMN IF NOT EXISTS archived_at timestamp;
    ALTER TABLE drafts ADD COLUMN IF NOT EXISTS archived_at timestamp;
    ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_draft_id_fkey;
    ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE RESTRICT;
    ALTER TABLE publish_jobs DROP CONSTRAINT IF EXISTS publish_jobs_account_id_fkey;
    ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_account_id_fkey FOREIGN KEY (account_id) REFERENCES hosted_accounts(id) ON DELETE RESTRICT;
    ALTER TABLE account_snapshots DROP CONSTRAINT IF EXISTS account_snapshots_account_id_fkey;
    ALTER TABLE account_snapshots ADD CONSTRAINT account_snapshots_account_id_fkey FOREIGN KEY (account_id) REFERENCES hosted_accounts(id) ON DELETE RESTRICT;
    ALTER TABLE media_assets DROP CONSTRAINT IF EXISTS media_assets_draft_id_fkey;
    ALTER TABLE media_assets ADD CONSTRAINT media_assets_draft_id_fkey FOREIGN KEY (draft_id) REFERENCES drafts(id) ON DELETE RESTRICT;
    ALTER TABLE postmortem_reports DROP CONSTRAINT IF EXISTS postmortem_reports_publish_job_id_fkey;
    ALTER TABLE postmortem_reports ADD CONSTRAINT postmortem_reports_publish_job_id_fkey FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id) ON DELETE RESTRICT;
    ALTER TABLE note_metrics DROP CONSTRAINT IF EXISTS note_metrics_publish_job_id_fkey;
    ALTER TABLE note_metrics ADD CONSTRAINT note_metrics_publish_job_id_fkey FOREIGN KEY (publish_job_id) REFERENCES publish_jobs(id) ON DELETE RESTRICT;
    CREATE UNIQUE INDEX hosted_accounts_identity ON hosted_accounts(user_id, platform, sub_type, xhs_user_id);
  ` },
];
export const EXPECTED_SCHEMA_VERSION = migrations.at(-1)!.version;
export const migrationChecksum = (migration: SchemaMigration) => createHash("sha256").update(JSON.stringify({
  version: migration.version, name: migration.name, statements: migration.statements.replace(/\r\n?/g, "\n"), backfillWritingAccount: !!migration.backfillWritingAccount,
})).digest("hex");
type AppliedMigration = { version: number; name: string; checksum: string; applied_at: string };
type Rows<T> = { rows: T[] };

async function tableExists(db: Db, table: string) {
  const result = await db.execute(sql`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=${table}) AS present`) as Rows<{ present: boolean }>;
  return !!result.rows[0]?.present;
}

export async function migrationStatus(db: Db) {
  const applied = await tableExists(db, "schema_migrations")
    ? (await db.execute(sql`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`) as Rows<AppliedMigration>).rows : [];
  return { expectedVersion: EXPECTED_SCHEMA_VERSION, applied, pending: migrations.filter(m => !applied.some(a => a.version === m.version)).map(m => ({ version: m.version, name: m.name })) };
}

function validateLedger(applied: AppliedMigration[], expected: readonly SchemaMigration[]) {
  for (let index = 0; index < applied.length; index++) {
    const row = applied[index]!;
    const migration = expected[index];
    if (!migration || row.version !== migration.version || row.name !== migration.name || row.checksum !== migrationChecksum(migration)) {
      throw new Error(`schema migration ledger mismatch at version ${row.version}; refusing migration/startup`);
    }
  }
}

/** Startup only inspects this ledger; production DDL belongs to the explicit migration CLI. */
export async function assertSchemaCurrent(db: Db) {
  const status = await migrationStatus(db);
  validateLedger(status.applied, migrations);
  if (status.pending.length) throw new Error(`schema version is not current (expected ${EXPECTED_SCHEMA_VERSION}); run the explicit db:migrate command before starting`);
  const columns = (await db.execute(sql`SELECT table_name, column_name FROM information_schema.columns WHERE table_schema=current_schema()`) as Rows<{ table_name: string; column_name: string }>).rows;
  const actual = new Set(columns.map(row => `${row.table_name}.${row.column_name}`));
  for (const table of Object.values(schema)) {
    if (!is(table, PgTable)) continue;
    for (const column of Object.values(getTableColumns(table))) {
      if (!actual.has(`${getTableName(table)}.${column.name}`)) throw new Error(`schema column missing: ${getTableName(table)}.${column.name}; refusing startup`);
    }
  }
  const policy = (await db.execute(sql`SELECT
    EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname=current_schema() AND tablename='hosted_accounts' AND indexname='hosted_accounts_identity' AND indexdef LIKE 'CREATE UNIQUE INDEX% (user_id, platform, sub_type, xhs_user_id)') AS identity_unique,
    (SELECT count(*) FROM pg_constraint WHERE connamespace=(SELECT oid FROM pg_namespace WHERE nspname=current_schema())
      AND conname IN ('publish_jobs_draft_id_fkey','publish_jobs_account_id_fkey','account_snapshots_account_id_fkey','media_assets_draft_id_fkey','postmortem_reports_publish_job_id_fkey','note_metrics_publish_job_id_fkey') AND confdeltype='r')=6 AS history_restrict`) as Rows<{ identity_unique: boolean; history_restrict: boolean }>).rows[0];
  if (!policy?.identity_unique || !policy.history_restrict) throw new Error("schema history/identity constraints are missing; refusing startup");
  return status;
}

export interface AccountIdentityProblem { user_id: number; platform: string; sub_type: string; xhs_user_id: string; ids: number[]; reason: string }
/** Read-only preflight. Archived records reserve their historical identity; input is never normalized here. */
export async function duplicateAccountIdentities(db: Db): Promise<AccountIdentityProblem[]> {
  if (!await tableExists(db, "hosted_accounts")) return [];
  const rows = (await db.execute(sql`SELECT id, user_id, platform, sub_type, xhs_user_id FROM hosted_accounts ORDER BY user_id, platform, sub_type, xhs_user_id, id`) as Rows<{ id: number; user_id: number; platform: string; sub_type: string; xhs_user_id: string }>).rows;
  const groups = new Map<string, AccountIdentityProblem>();
  for (const { id, ...row } of rows) {
    const key = JSON.stringify([row.user_id, row.platform, row.sub_type, row.xhs_user_id]);
    const invalid = [row.platform, row.sub_type, row.xhs_user_id].some(value => !value || value !== value.trim() || /[\s\u0000-\u001f\u007f]/u.test(value));
    const group = groups.get(key) ?? { ...row, ids: [], reason: invalid ? "blank or noncanonical identity" : "duplicate identity" };
    group.ids.push(id); groups.set(key, group);
  }
  return [...groups.values()].filter(group => group.ids.length > 1 || group.reason !== "duplicate identity");
}

/** Every change and ledger entry commits together; legacy identities never get merged or removed. */
export async function migrate(db: Db, options: { runtimeMode?: RuntimeMode; lockTimeoutMs?: number; migrations?: readonly SchemaMigration[] } = {}) {
  if (options.runtimeMode === "production-readonly") throw new Error("production-readonly refuses schema migrations");
  const plan = options.migrations ?? migrations;
  if (plan.some((migration, index) => migration.version !== index + 1)) throw new Error("migration versions must be contiguous from 1");
  const timeout = options.lockTimeoutMs ?? 10_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 60_000) throw new Error("invalid migration lock timeout");
  await db.transaction(async tx => {
    await tx.execute(sql`SELECT set_config('lock_timeout', ${`${timeout}ms`}, true)`);
    await tx.execute(sql`SELECT set_config('statement_timeout', '120s', true)`);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(1446149476, 2)`);
    await tx.execute(sql`CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, checksum varchar(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = (await tx.execute(sql`SELECT version, name, checksum, applied_at FROM schema_migrations ORDER BY version`) as Rows<AppliedMigration>).rows;
    validateLedger(applied, plan);
    for (const migration of plan.slice(applied.length)) {
      if (migration.version === 2) {
        const problems = await duplicateAccountIdentities(tx as unknown as Db);
        if (problems.length) throw new Error(`invalid or duplicate hosted account identities block migration; ${problems.length} group(s), run db:duplicates for IDs; no rows were changed`);
      }
      const before = migration.backfillWritingAccount ? (await tx.execute(sql`SELECT EXISTS (
        SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='drafts' AND column_name='account_id'
      ) AS present`) as Rows<{ present: boolean }>).rows[0]?.present : true;
      for (const statement of migration.statements.split(";").map(s => s.trim()).filter(Boolean)) await tx.execute(sql.raw(statement));
      if (!before) await tx.execute(sql`UPDATE drafts d SET account_id=t.account_id FROM (
        SELECT DISTINCT ON (draft_id, user_id) draft_id, user_id, account_id FROM topics
        WHERE draft_id IS NOT NULL AND account_id IS NOT NULL ORDER BY draft_id, user_id, updated_at DESC, id DESC
      ) t WHERE d.id=t.draft_id AND d.user_id=t.user_id AND d.account_id IS NULL`);
      await tx.execute(sql`INSERT INTO schema_migrations (version, name, checksum) VALUES (${migration.version}, ${migration.name}, ${migrationChecksum(migration)})`);
    }
  });
}
