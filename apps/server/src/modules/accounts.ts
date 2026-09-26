import { and, eq, lt } from "drizzle-orm";
import { Hono } from "hono";

import type { Deps } from "../context";
import { hostedAccounts } from "../db/schema";

/** 心跳超过 15 分钟没来的账号标记 stale。 */
export const STALE_MS = 15 * 60 * 1000;

export function accountsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const staleBefore = new Date(deps.now().getTime() - STALE_MS);
    await deps.db
      .update(hostedAccounts)
      .set({ status: "stale" })
      .where(
        and(
          eq(hostedAccounts.userId, userId),
          eq(hostedAccounts.status, "online"),
          lt(hostedAccounts.lastSeenAt, staleBefore),
        ),
      );
    const rows = await deps.db
      .select()
      .from(hostedAccounts)
      .where(eq(hostedAccounts.userId, userId));
    return c.json(rows);
  });

  app.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    await deps.db
      .delete(hostedAccounts)
      .where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, c.get("userId"))));
    return c.json({ ok: true });
  });

  return app;
}
