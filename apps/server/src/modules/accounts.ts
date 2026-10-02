import { and, eq, lt, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ACCOUNT_PERSONA_LIMITS } from "@v2media/shared";

import type { Deps } from "../context";
import { hostedAccounts } from "../db/schema";

/** 心跳超过 15 分钟没来的账号标记 stale。 */
export const STALE_MS = 15 * 60 * 1000;

export function accountsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  const personaSchema = z.object({
    version: z.number().int().nonnegative(),
    positioning: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.positioning).optional(),
    styleNotes: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.styleNotes).optional(),
    redlines: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.redlines).optional(),
  }).strict().refine(p => p.positioning !== undefined || p.styleNotes !== undefined || p.redlines !== undefined, "请提供人设字段");

  app.patch("/:id", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const p = personaSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "人设参数无效" }, 400);
    const userId = c.get("userId");
    const [owned] = await deps.db.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, userId)));
    if (!owned) return c.json({ error: "account not found" }, 404);
    const { version, ...fields } = p.data;
    const changed = (fields.positioning !== undefined && fields.positioning !== owned.positioning)
      || (fields.styleNotes !== undefined && fields.styleNotes !== owned.styleNotes)
      || (fields.redlines !== undefined && fields.redlines !== owned.redlines);
    const [updated] = await deps.db.update(hostedAccounts).set({ ...fields, personaVersion: sql`${hostedAccounts.personaVersion} + ${changed ? 1 : 0}` })
      .where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, userId), eq(hostedAccounts.personaVersion, version))).returning();
    return updated ? c.json(updated) : c.json({ error: "账号人设已更新，请读取最新内容后再保存" }, 409);
  });

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
      .where(eq(hostedAccounts.userId, userId))
      .orderBy(hostedAccounts.id);
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
