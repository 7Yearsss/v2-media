import { createHash, randomUUID } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import sharp from "sharp";
import { IMAGE_UPLOAD_LIMITS } from "@v2media/shared";
import type { Deps } from "../context";
import { drafts, jobs, mediaAssets } from "../db/schema";
import { assetDto, draftWithUploads } from "../lib/draft-media";
import { uploadDirectory } from "../lib/upload-jobs";
import { publicBase } from "../lib/media-store";

const fields = z.object({
  draftId: z.coerce.number().int().positive(),
  imagesVersion: z.coerce.number().int().nonnegative(),
  uploadId: z.string().uuid(),
});

export function mediaUploadModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.post("/upload", async c => {
    if (!deps.r2) return c.json({ error: "未配置图片存储，请先配置 R2 或使用图片链接", code: "storage_unavailable" }, 503);
    // Measure actual bytes even if Content-Length is absent or dishonest.
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: "缺少图片" }, 400);
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > IMAGE_UPLOAD_LIMITS.bytes + 64 * 1024) {
          await reader.cancel();
          return c.json({ error: "单张图片不能超过 10MiB" }, 413);
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let form: FormData;
    try { form = await new Response(Buffer.concat(chunks), { headers: { "content-type": c.req.header("content-type") ?? "" } }).formData(); }
    catch { return c.json({ error: "需要 multipart 图片表单" }, 400); }
    const parsed = fields.safeParse(Object.fromEntries(form));
    const file = form.get("file");
    if (!parsed.success || !(file instanceof File)) return c.json({ error: "图片上传参数无效" }, 400);
    if (!file.size || file.size > IMAGE_UPLOAD_LIMITS.bytes) return c.json({ error: "图片为空或超过 10MiB" }, 413);
    const userId = c.get("userId");
    const p = parsed.data;
    const [owned] = await deps.db.select().from(drafts).where(and(eq(drafts.id, p.draftId), eq(drafts.userId, userId)));
    if (!owned) return c.json({ error: "草稿不存在" }, 404);
    const bytes = Buffer.from(await file.arrayBuffer());
    try {
      const metadata = await sharp(bytes, { limitInputPixels: IMAGE_UPLOAD_LIMITS.pixels }).metadata();
      if (!["jpeg", "png", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) > 1
        || !metadata.width || !metadata.height || metadata.width * metadata.height > IMAGE_UPLOAD_LIMITS.pixels) throw new Error();
    } catch { return c.json({ error: "请选择有效的静态 JPEG、PNG 或 WebP 图片（最多 4000 万像素）" }, 415); }
    const hash = createHash("sha256").update(bytes).digest("hex");
    const sourceFile = randomUUID();
    await mkdir(uploadDirectory(deps), { recursive: true });
    await writeFile(join(uploadDirectory(deps), sourceFile), bytes, { flag: "wx" });
    let retained = false;
    try {
      const result = await deps.db.transaction(async tx => {
        // Serialises enqueue/reorder/cancel/worker writes for this draft.
        await tx.execute(sql`SELECT id FROM drafts WHERE id = ${p.draftId} AND user_id = ${userId} FOR UPDATE`);
        const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, p.draftId), eq(drafts.userId, userId)));
        if (!draft) return { code: 404 as const, error: "草稿不存在" };
        const [prior] = await tx.select().from(mediaAssets).where(and(eq(mediaAssets.userId, userId), eq(mediaAssets.uploadId, p.uploadId)));
        if (prior) {
          if (prior.draftId !== p.draftId || prior.sourceHash !== hash) return { code: 409 as const, error: "上传标识已被其他图片使用" };
          return { asset: prior, draft };
        }
        if (draft.imagesVersion !== p.imagesVersion) return { code: 409 as const, error: "图片列表已更新，请重新读取后再上传" };
        if (draft.images.length >= IMAGE_UPLOAD_LIMITS.images) return { code: 400 as const, error: "每篇草稿最多 9 张图片" };
        const [asset] = await tx.insert(mediaAssets).values({
          userId, draftId: draft.id, uploadId: p.uploadId, filename: file.name.slice(0, 255),
          sourceFile, sourceHash: hash,
        }).returning();
        const [updated] = await tx.update(drafts).set({
          images: [...draft.images, { url: "", assetId: asset!.id }], imagesVersion: draft.imagesVersion + 1, updatedAt: deps.now(),
        }).where(eq(drafts.id, draft.id)).returning();
        await tx.insert(jobs).values({ userId, type: "media_upload", status: "queued", payload: { assetId: asset!.id, base: publicBase(c.req) } });
        return { asset: asset!, draft: updated! };
      });
      if ("error" in result) return c.json({ error: result.error }, result.code!);
      retained = result.asset.sourceFile === sourceFile;
      return c.json({ asset: assetDto(result.asset), draft: await draftWithUploads(deps.db, result.draft) }, 202);
    } finally {
      if (!retained) await unlink(join(uploadDirectory(deps), sourceFile)).catch(() => {});
    }
  });

  app.get("/assets/:id", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const [asset] = await deps.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.userId, c.get("userId"))));
    return asset ? c.json(assetDto(asset)) : c.json({ error: "素材不存在" }, 404);
  });

  app.post("/assets/:id/retry", async c => {
    if (!deps.r2) return c.json({ error: "未配置图片存储", code: "storage_unavailable" }, 503);
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const [asset] = await deps.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, id), eq(mediaAssets.userId, c.get("userId"))));
    if (!asset) return c.json({ error: "素材不存在" }, 404);
    if (asset.kind === "cover") return c.json({ error: "请使用草稿封面入口重新生成" }, 400);
    const result = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${asset.draftId} FOR UPDATE`);
      const [draft] = await tx.select().from(drafts).where(eq(drafts.id, asset.draftId));
      if (!draft?.images.some(i => i.assetId === asset.id)) return null;
      const [updated] = await tx.update(mediaAssets).set({ status: "queued", error: null })
        .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, "failed"))).returning();
      if (!updated) return null;
      await tx.update(jobs).set({ status: "done", finishedAt: deps.now() }).where(and(eq(jobs.userId, asset.userId), eq(jobs.type, "media_upload"),
        inArray(jobs.status, ["failed", "queued"]), sql`${jobs.payload}->>'assetId' = ${String(asset.id)}`));
      await tx.insert(jobs).values({ userId: asset.userId, type: "media_upload", status: "queued", payload: { assetId: asset.id, base: publicBase(c.req) } });
      return updated;
    });
    return result ? c.json(assetDto(result), 202) : c.json({ error: "只能重试仍在草稿里的失败图片" }, 409);
  });
  return app;
}
