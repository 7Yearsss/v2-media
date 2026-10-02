import { closeDb, createDb } from "../src/db";
import { assertSchemaCurrent, duplicateAccountIdentities, migrate, migrationStatus } from "../src/db/migrate";
import { env } from "../src/env";

async function main() {
  const action = process.argv[2];
  if (!["migrate", "status", "check", "duplicates"].includes(action ?? "")) throw new Error("database command must be migrate, status, check or duplicates");
  if (action === "migrate" && env.runtimeMode === "production-readonly") throw new Error("production-readonly refuses schema migrations");
  const config = action === "migrate" && env.runtimeMode === "production-worker" && process.env.MIGRATION_DATABASE_URL
    ? { ...env, databaseUrl: process.env.MIGRATION_DATABASE_URL } : env;
  const db = await createDb(config);
  try {
    if (action === "migrate") { await migrate(db, { runtimeMode: env.runtimeMode }); console.log(JSON.stringify(await assertSchemaCurrent(db))); }
    if (action === "status") console.log(JSON.stringify(await migrationStatus(db)));
    if (action === "check") console.log(JSON.stringify(await assertSchemaCurrent(db)));
    if (action === "duplicates") {
      const problems = await duplicateAccountIdentities(db);
      console.log(JSON.stringify({ groups: problems }));
      if (problems.length) process.exitCode = 1;
    }
  } finally { await closeDb(db); }
}

main().catch(error => { console.error(error instanceof Error ? error.message : "database command failed"); process.exitCode = 1; });
