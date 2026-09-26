import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, drafts } from "../db/schema";

const createSchema = z.object({
  collectedNoteId: z.number().int().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.object({ url: z.string() })).optional(),
});

const updateSchema = z.object({
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.object({ url: z.string() })).optional(),
  status: z.enum(["draft", "ready"]).optional(),
});

export function draftsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const rows = await deps.db
      .select()
      .from(drafts)
      .where(eq(drafts.userId, c.get("userId")))
      .orderBy(desc(drafts.updatedAt));
    return c.json({ items: rows });
  });

  /** 从内容库深拷贝为草稿（或创建空草稿）。 */
  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    let values = {
      userId,
      title: p.title ?? "",
      content: p.content ?? "",
      tags: p.tags ?? [],
      images: p.images ?? [],
    };
    if (p.collectedNoteId) {
      const [note] = await deps.db
        .select()
        .from(collectedNotes)
        .where(and(eq(collectedNotes.id, p.collectedNoteId), eq(collectedNotes.userId, userId)))
        .limit(1);
      if (!note) return c.json({ error: "collected note not found" }, 404);
      values = {
        userId,
        title: note.title,
        content: note.content || note.title,
        tags: note.tags,
        images: note.images.map((i) => ({ url: i.url })),
      };
    }
    const [draft] = await deps.db
      .insert(drafts)
      .values({ ...values, collectedNoteId: p.collectedNoteId })
      .returning();
    return c.json(draft);
  });

  app.get("/:id", async (c) => getOwned(c, deps));
  app.patch("/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [existing] = await deps.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, id), eq(drafts.userId, userId)))
      .limit(1);
    if (!existing) return c.json({ error: "not found" }, 404);
    const [row] = await deps.db
      .update(drafts)
      .set({ ...parsed.data, updatedAt: deps.now() })
      .where(eq(drafts.id, id))
      .returning();
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    await deps.db
      .delete(drafts)
      .where(and(eq(drafts.id, Number(c.req.param("id"))), eq(drafts.userId, c.get("userId"))));
    return c.json({ ok: true });
  });

  return app;
}

async function getOwned(c: any, deps: Deps) {
  const [row] = await deps.db
    .select()
    .from(drafts)
    .where(and(eq(drafts.id, Number(c.req.param("id"))), eq(drafts.userId, c.get("userId"))))
    .limit(1);
  if (!row) return c.json({ error: "not found" }, 404);
  return c.json(row);
}
