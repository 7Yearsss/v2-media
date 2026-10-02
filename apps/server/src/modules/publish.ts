import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { drafts, hostedAccounts, mediaAssets, publishJobs } from "../db/schema";
import { snapshotPersona } from "../lib/account-persona";

const createSchema = z.object({
  draftId: z.number().int(),
  accountId: z.number().int().positive(),
  personaVersion: z.number().int().nonnegative().optional(),
  scheduledAt: z.number().int().optional(),
  visibility: z.enum(["public", "private", "friends"]).default("public"),
});

export function publishModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/jobs", async (c) => {
    const rows = await deps.db
      .select()
      .from(publishJobs)
      .where(eq(publishJobs.userId, c.get("userId")))
      .orderBy(desc(publishJobs.id))
      .limit(200);
    return c.json(rows);
  });

  app.post("/jobs", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    const result = await deps.db.transaction(async tx => {
      // Freeze the reviewed account fields and draft together; heartbeat/foreign-key locks remain compatible.
      await tx.execute(sql`SELECT id FROM hosted_accounts WHERE id = ${p.accountId} AND user_id = ${userId} FOR SHARE`);
      const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, p.accountId), eq(hostedAccounts.userId, userId)));
      if (!account) return { error: "account not found", code: 404 as const };
      if (p.personaVersion !== undefined && p.personaVersion !== account.personaVersion)
        return { error: "目标账号人设已更新，请重新读取并核对红线", code: 409 as const };
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${p.draftId} AND user_id = ${userId} FOR UPDATE`);
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, p.draftId), eq(drafts.userId, userId)));
      if (!draft) return { error: "draft not found", code: 404 as const };
      if (["queued", "writing"].includes(draft.generationState) || ["queued", "processing"].includes(draft.coverState))
        return { error: "草稿或封面仍在生成，请完成后再发布", code: 400 as const };
      if (!draft.title.trim() || !draft.images.length) return { error: "草稿需要标题和至少一张图片", code: 400 as const };
      const assets = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.draftId, draft.id), eq(mediaAssets.userId, userId)));
      if (draft.images.some(i => !i.url.trim() || (i.assetId && !assets.some(a => a.id === i.assetId && a.status === "ready" && a.url === i.url))))
        return { error: "草稿图片尚未上传完成，请等待或移除失败图片", code: 400 as const };
      const [job] = await tx.insert(publishJobs).values({
        userId, draftId: p.draftId, accountId: p.accountId,
        scheduledAt: p.scheduledAt ? new Date(p.scheduledAt) : null, visibility: p.visibility,
        draftSnapshot: { title: draft.title, content: draft.content, tags: draft.tags, images: draft.images },
        personaSnapshot: snapshotPersona(account),
      }).returning();
      return { job: job! };
    });
    return "error" in result ? c.json({ error: result.error }, result.code!) : c.json(result.job);
  });

  app.post("/jobs/:id/cancel", async (c) => {
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
