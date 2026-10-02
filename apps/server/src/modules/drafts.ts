import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, drafts, hostedAccounts, mediaAssets } from "../db/schema";
import { draftWithUploads } from "../lib/draft-media";
import { IMAGE_UPLOAD_LIMITS } from "@v2media/shared";

const createSchema = z.object({
  accountId: z.number().int().positive().optional(),
  collectedNoteId: z.number().int().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.object({ url: z.string() })).max(IMAGE_UPLOAD_LIMITS.images).optional(),
});

const updateSchema = z.object({
  accountId: z.number().int().positive().nullable().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  images: z.array(z.object({ url: z.string(), assetId: z.number().int().positive().optional(),
    width: z.number().int().positive().optional(), height: z.number().int().positive().optional() })).max(IMAGE_UPLOAD_LIMITS.images).optional(),
  imagesVersion: z.number().int().nonnegative().optional(),
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
    return c.json(rows);
  });

  /** 从内容库深拷贝为草稿（或创建空草稿）。 */
  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    if (p.accountId) {
      const [account] = await deps.db.select({ id: hostedAccounts.id }).from(hostedAccounts).where(and(eq(hostedAccounts.id, p.accountId), eq(hostedAccounts.userId, userId)));
      if (!account) return c.json({ error: "account not found" }, 404);
    }
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
      .values({ ...values, collectedNoteId: p.collectedNoteId, accountId: p.accountId })
      .returning();
    return c.json(draft);
  });

  app.get("/:id", async (c) => getOwned(c, deps));
  app.patch("/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const result = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
      const [existing] = await tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.userId, userId)));
      if (!existing) return { error: "not found", code: 404 as const };
      const { imagesVersion, ...patch } = parsed.data;
      if (patch.accountId) {
        const [account] = await tx.select({ id: hostedAccounts.id }).from(hostedAccounts).where(and(eq(hostedAccounts.id, patch.accountId), eq(hostedAccounts.userId, userId)));
        if (!account) return { error: "account not found", code: 404 as const };
      }
      if (patch.images) {
        if ((existing.images.some(i => i.assetId) || patch.images.some(i => i.assetId)) && imagesVersion === undefined)
          return { error: "修改上传图集需要 imagesVersion", code: 428 as const };
        if (imagesVersion !== undefined && imagesVersion !== existing.imagesVersion)
          return { error: "图片列表已更新，请重新读取后再编辑", code: 409 as const };
        const ownedAssets = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.draftId, id)));
        const assetIds = new Set<number>();
        for (const image of patch.images) {
          if (!image.assetId) {
            if (!/^https?:\/\//.test(image.url)) return { error: "图片链接必须是 http(s) 地址", code: 400 as const };
            continue;
          }
          const a = ownedAssets.find(a => a.id === image.assetId);
          if (!a || a.status === "canceled" || !existing.images.some(i => i.assetId === a.id) || assetIds.has(a.id))
            return { error: "图片素材不存在或已移除", code: 400 as const };
          assetIds.add(a.id);
          image.url = a.status === "ready" ? a.url! : "";
          if (a.status === "ready" && a.width && a.height) { image.width = a.width; image.height = a.height; }
        }
        const removed = ownedAssets.filter(a => existing.images.some(i => i.assetId === a.id) && !assetIds.has(a.id)).map(a => a.id);
        if (removed.length) await tx.update(mediaAssets).set({ status: "canceled" }).where(inArray(mediaAssets.id, removed));
      }
      const removedCover = !!patch.images && !!existing.coverAssetId && !patch.images.some(i => i.assetId === existing.coverAssetId);
      if (removedCover) await tx.update(mediaAssets).set({ status: "canceled" }).where(and(eq(mediaAssets.userId, userId),
        eq(mediaAssets.draftId, id), eq(mediaAssets.kind, "cover"), inArray(mediaAssets.status, ["queued", "processing", "failed"])));
      const editedText = patch.title !== undefined || patch.content !== undefined || patch.tags !== undefined
        || (patch.accountId !== undefined && patch.accountId !== existing.accountId);
      const [row] = await tx.update(drafts).set({
        ...patch, ...(patch.images ? { imagesVersion: existing.imagesVersion + 1 } : {}), updatedAt: deps.now(),
        ...(editedText ? { textVersion: existing.textVersion + 1 } : {}),
        ...(removedCover ? { coverState: "idle", coverError: null, coverAssetId: null, coverRevision: existing.coverRevision + 1 } : {}),
      }).where(eq(drafts.id, id)).returning();
      return { draft: row! };
    });
    if ("error" in result) return c.json({ error: result.error }, result.code!);
    return c.json(await draftWithUploads(deps.db, result.draft));
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
  return c.json(await draftWithUploads(deps.db, row));
}
