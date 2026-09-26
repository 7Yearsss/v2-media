import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { drafts, hostedAccounts, publishJobs } from "../db/schema";

const createSchema = z.object({
  draftId: z.number().int(),
  accountId: z.number().int(),
  scheduledAt: z.number().int().optional(),
  visibility: z.enum(["public", "private", "friends"]).default("public"),
});

export function publishModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const rows = await deps.db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.userId, c.get("userId")))
      .orderBy(desc(publishJobs.id))
      .limit(200);
    return c.json({ items: rows });
  });

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    const [draft] = await deps.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, p.draftId), eq(drafts.userId, userId)))
      .limit(1);
    if (!draft) return c.json({ error: "draft not found" }, 404);
    if (!draft.title.trim() || !draft.images.length)
      return c.json({ error: "草稿需要标题和至少一张图片" }, 400);
    const [account] = await deps.db
      .select()
      .from(hostedAccounts)
      .where(and(eq(hostedAccounts.id, p.accountId), eq(hostedAccounts.userId, userId)))
      .limit(1);
    if (!account) return c.json({ error: "account not found" }, 404);
    const [job] = await deps.db
      .insert(publishJobs)
      .values({
        userId,
        draftId: p.draftId,
        accountId: p.accountId,
        scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : null,
        visibility: p.visibility,
      })
      .returning();
    return c.json(job);
  });

  app.post("/:id/cancel", async (c) => {
    const id = Number(c.req.param("id"));
    const [row] = await deps.db
      .update(publishJobs)
      .set({ status: "canceled", updatedAt: deps.now() })
      .where(
        and(
          eq(publishJobs.id, id),
          eq(publishJobs.userId, c.get("userId")),
          eq(publishJobs.status, "pending"),
        ),
      )
      .returning();
    if (!row) return c.json({ error: "not found or not cancelable" }, 404);
    return c.json(row);
  });

  return app;
}
