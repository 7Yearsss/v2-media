import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { env } from "../env";
import { validateRuntimeConfig, type RuntimeConfig } from "../runtime";
import * as schema from "./schema";

export type Db = PgDatabase<any, typeof schema>;
const closers = new WeakMap<Db, () => Promise<void>>();
export const closeDb = async (db: Db) => { await closers.get(db)?.(); };

/** URI options override Pool options in pg, so set the safety option in both locations. */
export function postgresConnectionOptions(config: RuntimeConfig) {
  const target = new URL(config.databaseUrl);
  if (config.runtimeMode === "production-readonly") target.searchParams.set("options", "-c default_transaction_read_only=on");
  return { connectionString: target.toString(), ...(config.runtimeMode === "production-readonly" ? { options: "-c default_transaction_read_only=on" } : {}), connectionTimeoutMillis: 10_000 };
}

/** Verify effective grants and inherited ownership, not just the role's name or session switch. */
export async function assertReadonlyRole(db: Db) {
  const result = await db.execute(sql`WITH reachable_roles AS (
    SELECT * FROM pg_roles WHERE rolname=current_user OR pg_has_role(current_user, oid, 'MEMBER')
  ) SELECT current_user AS role,
    current_setting('default_transaction_read_only')='on' AS connection_readonly,
    NOT EXISTS (SELECT 1 FROM reachable_roles WHERE rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls) AS unprivileged,
    NOT EXISTS (SELECT 1 FROM reachable_roles r WHERE pg_has_role(r.oid, 'pg_database_owner', 'MEMBER') OR has_database_privilege(r.oid, current_database(), 'CREATE')) AS database_safe,
    NOT EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN reachable_roles r WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND (r.oid=n.nspowner OR has_schema_privilege(r.oid, n.oid, 'CREATE'))) AS schemas_safe,
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN reachable_roles r WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema' AND (
      r.oid=c.relowner OR (c.relkind IN ('r','p','v','m','f') AND (has_table_privilege(r.oid, c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') OR has_any_column_privilege(r.oid, c.oid, 'INSERT,UPDATE,REFERENCES')))
      OR (c.relkind='S' AND has_sequence_privilege(r.oid, c.oid, 'USAGE,UPDATE')))) AS relations_safe,
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN reachable_roles r WHERE n.nspname !~ '^pg_' AND n.nspname <> 'information_schema'
      AND p.prosecdef AND has_function_privilege(r.oid, p.oid, 'EXECUTE')) AS functions_safe`) as { rows: Array<{ role: string; connection_readonly: boolean; unprivileged: boolean; database_safe: boolean; schemas_safe: boolean; relations_safe: boolean; functions_safe: boolean }> };
  const policy = result.rows[0];
  if (!policy || !policy.connection_readonly || !policy.unprivileged || !policy.database_safe || !policy.schemas_safe || !policy.relations_safe || !policy.functions_safe) {
    throw new Error("production-readonly requires a dedicated PostgreSQL role without ownership, write or CREATE grants and read-only connections");
  }
}

export async function createDb(config: RuntimeConfig & { dataDir: string } = env): Promise<Db> {
  validateRuntimeConfig(config);
  if (config.runtimeMode !== "local-isolated") {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    const pool = new Pool(postgresConnectionOptions(config));
    const db = drizzle(pool, { schema }) as unknown as Db;
    closers.set(db, () => pool.end());
    try { if (config.runtimeMode === "production-readonly") await assertReadonlyRole(db); }
    catch (error) { await pool.end(); throw error; }
    return db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(config.dataDir, { recursive: true });
  const client = new PGlite(`${config.dataDir}/pglite`);
  const db = drizzle(client, { schema }) as unknown as Db;
  closers.set(db, () => client.close());
  return db;
}
