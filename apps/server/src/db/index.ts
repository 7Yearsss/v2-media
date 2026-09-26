import type { PgDatabase } from "drizzle-orm/pg-core";

import { env } from "../env";
import * as schema from "./schema";

/**
 * dev/test: 内嵌 PGlite（env.dataDir，单写者）。
 * prod: DATABASE_URL -> node-postgres。
 * 两者都是 pg dialect，统一按 PgDatabase 暴露。
 */
export type Db = PgDatabase<any, typeof schema>;

export async function createDb(): Promise<Db> {
  if (env.databaseUrl) {
    const { Pool } = await import("pg");
    const { drizzle } = await import("drizzle-orm/node-postgres");
    return drizzle(new Pool({ connectionString: env.databaseUrl }), { schema }) as unknown as Db;
  }
  const { PGlite } = await import("@electric-sql/pglite");
  const { drizzle } = await import("drizzle-orm/pglite");
  const { mkdirSync } = await import("node:fs");
  mkdirSync(env.dataDir, { recursive: true });
  return drizzle(new PGlite(`${env.dataDir}/pglite`), { schema }) as unknown as Db;
}
