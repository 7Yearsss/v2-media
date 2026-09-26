import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Deps } from "../context";
import { collectedNotes, drafts, hostedAccounts, publishJobs } from "../db/schema";

export function overviewModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const count = async (table: any) =>
      (await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.userId, userId)))[0]!.n;
    const [accounts, notes, draftCount, jobs] = await Promise.all([
      count(hostedAccounts),
      count(collectedNotes),
      count(drafts),
      count(publishJobs),
    ]);
    return c.json({ accounts, notes, drafts: draftCount, publishJobs: jobs });
  });

  return app;
}
