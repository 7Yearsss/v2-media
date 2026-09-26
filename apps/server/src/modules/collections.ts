import { and, count, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, collections } from "../db/schema";

const nameSchema = z.object({
  name: z.string().trim().min(1, "name required").max(64),
});

/** 采集分组 CRUD：列表带各库笔记数；删库只置空笔记的 collection_id（SET NULL）。 */
export function collectionsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const rows = await deps.db
      .select({
        id: collections.id,
        name: collections.name,
        createdAt: collections.createdAt,
        noteCount: count(collectedNotes.id),
      })
      .from(collections)
      .leftJoin(collectedNotes, eq(collectedNotes.collectionId, collections.id))
      .where(eq(collections.userId, userId))
      .groupBy(collections.id)
      .orderBy(collections.id);
    return c.json({ items: rows });
  });

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    // 同名直接返回已有库（幂等：插件/工作台重复创建不报错）
    const [existing] = await deps.db
      .select()
      .from(collections)
      .where(and(eq(collections.userId, userId), eq(collections.name, parsed.data.name)))
      .limit(1);
    if (existing) return c.json({ ...existing, noteCount: 0 });
    const [row] = await deps.db
      .insert(collections)
      .values({ userId, name: parsed.data.name })
      .returning();
    return c.json({ ...row!, noteCount: 0 }, 201);
  });

  app.patch("/:id", async (c) => {
    const userId = c.get("userId");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(collections)
      .set({ name: parsed.data.name })
      .where(and(eq(collections.id, Number(c.req.param("id"))), eq(collections.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const [row] = await deps.db
      .delete(collections)
      .where(and(eq(collections.id, Number(c.req.param("id"))), eq(collections.userId, userId)))
      .returning({ id: collections.id });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  return app;
}
