import { createHash } from "node:crypto";
import { readFile, readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import sharp from "sharp";
import { IMAGE_UPLOAD_LIMITS } from "@v2media/shared";
import type { Deps } from "../context";
import { drafts, jobs, mediaAssets } from "../db/schema";
import { env } from "../env";

export const uploadDirectory = (deps: Deps) => deps.uploadDir ?? join(env.dataDir, "uploads");
interface Payload { assetId: number; base: string; attempts?: number }
const fileFor = (deps: Deps, name: string) => {
  if (!/^[0-9a-f-]{36}$/.test(name)) throw new Error("上传暂存文件无效");
  return join(uploadDirectory(deps), name);
};

export async function runUploadJobs(deps: Deps) {
  if (!deps.r2) return;
  const now = deps.now();
  await deps.db.update(jobs).set({ status: "queued", claimedAt: null }).where(and(
    eq(jobs.type, "media_upload"), eq(jobs.status, "processing"), lt(jobs.claimedAt, new Date(now.getTime() - 20 * 60_000)),
  ));
  const [job] = await deps.db.select().from(jobs).where(and(eq(jobs.type, "media_upload"), eq(jobs.status, "queued"),
    or(isNull(jobs.dueAt), lte(jobs.dueAt, now)))).orderBy(jobs.id).limit(1);
  if (!job) return;
  const [claimed] = await deps.db.update(jobs).set({ status: "processing", claimedAt: now })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued"))).returning();
  if (!claimed) return;
  const p = job.payload as Payload;
  const [asset] = await deps.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, p.assetId), eq(mediaAssets.userId, job.userId)));
  const finish = async () => {
    await deps.db.update(jobs).set({ status: "done", error: null, finishedAt: deps.now() }).where(eq(jobs.id, job.id));
    if (asset) await unlink(fileFor(deps, asset.sourceFile)).catch(() => {});
  };
  if (!asset || asset.status === "canceled" || asset.status === "ready") { await finish(); return; }
  try {
    const active = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${asset.draftId} FOR UPDATE`);
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, asset.draftId), eq(drafts.userId, job.userId)));
      if (!draft?.images.some(i => i.assetId === asset.id)) {
        await tx.update(mediaAssets).set({ status: "canceled" }).where(eq(mediaAssets.id, asset.id));
        return false;
      }
      const [row] = await tx.update(mediaAssets).set({ status: "processing", error: null })
        .where(and(eq(mediaAssets.id, asset.id), inArray(mediaAssets.status, ["queued", "processing"]))).returning();
      return !!row;
    });
    if (!active) { await finish(); return; }
    const source = await readFile(fileFor(deps, asset.sourceFile));
    const metadata = await sharp(source, { limitInputPixels: IMAGE_UPLOAD_LIMITS.pixels }).metadata();
    const pipeline = sharp(source, { limitInputPixels: IMAGE_UPLOAD_LIMITS.pixels }).rotate()
      .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true });
    const { data, info } = await (metadata.format === "jpeg" ? pipeline.jpeg({ quality: 95 }) : pipeline.png()).toBuffer({ resolveWithObject: true });
    if (data.length > IMAGE_UPLOAD_LIMITS.bytes) throw new Error("处理后的图片超过 10MiB，请缩小图片后重新上传");
    const key = "upload/" + createHash("sha256").update(String(job.userId) + ":").update(data).digest("hex");
    if (!/^https?:\/\//.test(p.base)) throw new Error("未配置有效的图片访问地址");
    const [reserved] = await deps.db.update(mediaAssets).set({ key })
      .where(and(eq(mediaAssets.id, asset.id), eq(mediaAssets.status, "processing"))).returning();
    if (!reserved) { await finish(); return; }
    if (!(await deps.r2.head(key))) {
      const objects = (await Promise.all(["img/", "vid/", "avatar/", "upload/", "cover/"].map(prefix => deps.r2!.list(prefix)))).flat();
      if (env.r2MaxBytes > 0 && objects.reduce((n, o) => n + o.size, 0) + data.length > env.r2MaxBytes)
        throw new Error("图片存储容量不足，请联系管理员扩容");
      await deps.r2.put(key, Uint8Array.from(data).buffer, metadata.format === "jpeg" ? "image/jpeg" : "image/png");
    }
    const url = p.base.replace(/\/$/, "") + "/api/media/objects/" + key;
    await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${asset.draftId} FOR UPDATE`);
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, asset.draftId), eq(drafts.userId, job.userId)));
      const [current] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
      if (!current) return;
      if (current.status === "canceled" || !draft?.images.some(i => i.assetId === asset.id)) {
        await tx.update(mediaAssets).set({ status: "canceled", key, url }).where(eq(mediaAssets.id, asset.id));
        return;
      }
      await tx.update(mediaAssets).set({ status: "ready", key, url, width: info.width, height: info.height, error: null }).where(eq(mediaAssets.id, asset.id));
      await tx.update(drafts).set({
        images: draft.images.map(i => i.assetId === asset.id ? { url, assetId: asset.id, width: info.width, height: info.height } : i),
        imagesVersion: draft.imagesVersion + 1, updatedAt: deps.now(),
      }).where(eq(drafts.id, draft.id));
    });
    await finish();
  } catch (error) {
    const attempts = (p.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : "图片存储失败";
    await deps.db.update(mediaAssets).set({ status: attempts < 3 ? "queued" : "failed", error: message })
      .where(and(eq(mediaAssets.id, p.assetId), eq(mediaAssets.userId, job.userId), inArray(mediaAssets.status, ["queued", "processing"])));
    await deps.db.update(jobs).set({
      status: attempts < 3 ? "queued" : "failed", payload: { ...p, attempts },
      dueAt: new Date(deps.now().getTime() + attempts * 30_000), error: message,
    }).where(eq(jobs.id, job.id));
  }
}

/** Sweep orphan source files after a day; referenced failed uploads remain retryable. */
export async function sweepUploadSources(deps: Deps) {
  const active = await deps.db.select().from(mediaAssets).where(inArray(mediaAssets.status, ["queued", "processing", "failed"]));
  const referenced = new Set(active.map(a => a.sourceFile));
  for (const file of await readdir(uploadDirectory(deps)).catch(() => [] as string[])) {
    if (!/^[0-9a-f-]{36}$/.test(file)) continue;
    if (!referenced.has(file) && (await stat(fileFor(deps, file))).mtimeMs < deps.now().getTime() - 86400_000)
      await unlink(fileFor(deps, file)).catch(() => {});
  }
  // Do not silently expire failed files: user can explicitly remove their placeholder.
}

export function startUploadWorker(deps: Deps) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runUploadJobs(deps); } catch (e) { console.warn("upload worker failed", e); }
    finally { busy = false; }
  };
  void tick();
  if (!env.disableMediaMaintenance) {
    void sweepUploadSources(deps).catch(e => console.warn("upload source sweep failed", e));
    setInterval(() => void sweepUploadSources(deps).catch(e => console.warn("upload source sweep failed", e)), 3600_000).unref();
  }
  return setInterval(() => void tick(), 2000).unref();
}
