import { and, eq, gt, ilike, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Deps } from "../context";
import { collectedNotes } from "../db/schema";

const PAGE = 30;

export function notesModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const cursor = Number(c.req.query("cursor") ?? 0);
    const keyword = (c.req.query("keyword") ?? "").trim();
    const source = (c.req.query("source") ?? "").trim();
    const tag = (c.req.query("tag") ?? "").trim();
    const conds = [eq(collectedNotes.userId, userId), gt(collectedNotes.id, cursor)];
    if (keyword) {
      const like = `%${keyword}%`;
      conds.push(or(ilike(collectedNotes.title, like), ilike(collectedNotes.authorName, like))!);
    }
    if (source) conds.push(eq(collectedNotes.source, source));
    // collectionId：数字=该库；字面量 "none"=只看未分组的
    const collectionId = (c.req.query("collectionId") ?? "").trim();
    if (collectionId === "none") {
      conds.push(sql`${collectedNotes.collectionId} IS NULL`);
    } else if (collectionId) {
      conds.push(eq(collectedNotes.collectionId, Number(collectionId)));
    }
    if (tag) conds.push(sql`${collectedNotes.tags} @> ${JSON.stringify([tag])}::jsonb`);
    const rows = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(...conds))
      .orderBy(collectedNotes.id)
      .limit(PAGE + 1);
    const items = rows.slice(0, PAGE);
    return c.json({
      items,
      nextCursor: rows.length > PAGE ? items[items.length - 1]!.id : null,
    });
  });

  app.get("/:id", async (c) => {
    const [row] = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(eq(collectedNotes.id, Number(c.req.param("id"))), eq(collectedNotes.userId, c.get("userId"))))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    await deps.db
      .delete(collectedNotes)
      .where(and(eq(collectedNotes.id, Number(c.req.param("id"))), eq(collectedNotes.userId, c.get("userId"))));
    return c.json({ ok: true });
  });

  return app;
}
