import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, isNull, lt, lte, or, sql } from "drizzle-orm";
import { IMAGE_UPLOAD_LIMITS, type CoverSpec } from "@v2media/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { drafts, jobs, mediaAssets } from "../db/schema";
import { renderCover, COVER_RENDER_VERSION } from "./cover-render";
import { coverTemplateName } from "./cover-spec";
import { storeCreatedMedia } from "./created-media";

type DraftRow = typeof drafts.$inferSelect;
export class CoverInputError extends Error {}
interface Payload { draftId: number; assetId: number; revision: number; base: string; attempts?: number }

/** Caller owns and locks draft. Queueing and its placeholder are one DB transaction. */
export async function queueCover(db: Db, deps: Deps, draft: DraftRow, spec: CoverSpec, base: string) {
  const previous = draft.images.find(i => i.assetId === draft.coverAssetId);
  if (!previous && draft.images.length >= IMAGE_UPLOAD_LIMITS.images) throw new CoverInputError("请先移除一张图片，为封面留出位置");
  if (spec.backgroundAssetId) {
    const [background] = await db.select().from(mediaAssets).where(and(
      eq(mediaAssets.id, spec.backgroundAssetId), eq(mediaAssets.userId, draft.userId), eq(mediaAssets.kind, "upload"), eq(mediaAssets.status, "ready"),
    ));
    if (!background?.key) throw new CoverInputError("请选择自己已上传完成的底图");
  }
  // Supersede only unfinished covers. The last usable cover survives failed regeneration.
  await db.update(mediaAssets).set({ status: "canceled" }).where(and(eq(mediaAssets.userId, draft.userId),
    eq(mediaAssets.draftId, draft.id), eq(mediaAssets.kind, "cover"), inArray(mediaAssets.status, ["queued", "processing", "failed"])));
  const revision = draft.coverRevision + 1;
  const [asset] = await db.insert(mediaAssets).values({
    userId: draft.userId, draftId: draft.id, kind: "cover", uploadId: randomUUID(),
    filename: coverTemplateName(spec.templateId) + ".png", sourceFile: randomUUID(),
    sourceHash: createHash("sha256").update(JSON.stringify({ version: COVER_RENDER_VERSION, spec })).digest("hex"),
  }).returning();
  const id = asset!.id;
  const retainPrevious = !!previous?.url;
  const images = retainPrevious ? draft.images : [
    { url: "", assetId: id }, ...draft.images.filter(i => i.assetId !== draft.coverAssetId),
  ];
  const [updated] = await db.update(drafts).set({
    coverSpec: spec, coverRevision: revision, coverState: "queued", coverError: null,
    coverAssetId: retainPrevious ? draft.coverAssetId : id,
    images, imagesVersion: draft.imagesVersion + (retainPrevious ? 0 : 1), updatedAt: deps.now(),
  }).where(eq(drafts.id, draft.id)).returning();
  const [job] = await db.insert(jobs).values({
    userId: draft.userId, type: "cover_generate", status: "queued", payload: { draftId: draft.id, assetId: id, revision, base },
  }).returning();
  return { draft: updated!, jobId: job!.id };
}

export async function runCoverJobs(deps: Deps) {
  if (!deps.r2) return;
  await deps.db.update(jobs).set({ status: "queued", claimedAt: null }).where(and(eq(jobs.type, "cover_generate"),
    eq(jobs.status, "processing"), lt(jobs.claimedAt, new Date(deps.now().getTime() - 20 * 60_000))));
  const [job] = await deps.db.select().from(jobs).where(and(eq(jobs.type, "cover_generate"), eq(jobs.status, "queued"),
    or(isNull(jobs.dueAt), lte(jobs.dueAt, deps.now())))).orderBy(jobs.id).limit(1);
  if (!job) return;
  const [claimed] = await deps.db.update(jobs).set({ status: "processing", claimedAt: deps.now() })
    .where(and(eq(jobs.id, job.id), eq(jobs.status, "queued"))).returning();
  if (!claimed) return;
  const p = job.payload as Payload;
  const done = () => deps.db.update(jobs).set({ status: "done", error: null, finishedAt: deps.now() }).where(eq(jobs.id, job.id));
  const obsolete = async () => {
    await deps.db.update(mediaAssets).set({ status: "canceled" }).where(and(eq(mediaAssets.id, p.assetId), eq(mediaAssets.userId, job.userId)));
    await done();
  };
  const [draft] = await deps.db.select().from(drafts).where(and(eq(drafts.id, p.draftId), eq(drafts.userId, job.userId)));
  const [asset] = await deps.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, p.assetId), eq(mediaAssets.draftId, p.draftId),
    eq(mediaAssets.userId, job.userId), eq(mediaAssets.kind, "cover")));
  if (!draft || !asset || !draft.coverSpec || draft.coverRevision !== p.revision || asset.status === "canceled") { await obsolete(); return; }
  if (asset.status === "ready") { await done(); return; }
  try {
    const [active] = await deps.db.update(mediaAssets).set({ status: "processing", error: null }).where(and(
      eq(mediaAssets.id, asset.id), inArray(mediaAssets.status, ["queued", "processing"]))).returning();
    if (!active) { await obsolete(); return; }
    await deps.db.update(drafts).set({ coverState: "processing" }).where(and(eq(drafts.id, draft.id), eq(drafts.coverRevision, p.revision)));
    let background: Buffer | undefined;
    if (draft.coverSpec.templateId === "photo") {
      const [photo] = await deps.db.select().from(mediaAssets).where(and(eq(mediaAssets.id, draft.coverSpec.backgroundAssetId!),
        eq(mediaAssets.userId, job.userId), eq(mediaAssets.kind, "upload"), eq(mediaAssets.status, "ready")));
      const response = photo?.key ? await deps.r2.get(photo.key) : null;
      if (!response?.ok) throw new Error("底图不可用，请重新选择自己的图片");
      // Only uploaded assets, whose stored bytes are already limited to 10MiB.
      background = Buffer.from(await response.arrayBuffer());
      if (background.length > IMAGE_UPLOAD_LIMITS.bytes) throw new Error("底图超过大小限制");
    }
    const bytes = await renderCover(draft.coverSpec, background);
    const stored = await storeCreatedMedia(deps, job.userId, asset.id, "cover", bytes, "image/png", p.base);
    if (!stored) { await obsolete(); return; }
    await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${draft.id} FOR UPDATE`);
      const [current] = await tx.select().from(drafts).where(and(eq(drafts.id, draft.id), eq(drafts.userId, job.userId)));
      const [currentAsset] = await tx.select().from(mediaAssets).where(eq(mediaAssets.id, asset.id));
      if (!current || current.coverRevision !== p.revision || currentAsset?.status === "canceled") {
        await tx.update(mediaAssets).set({ status: "canceled", ...stored }).where(eq(mediaAssets.id, asset.id));
        return;
      }
      const previousId = current.coverAssetId;
      if (previousId && previousId !== asset.id) await tx.update(mediaAssets).set({ status: "canceled" })
        .where(and(eq(mediaAssets.id, previousId), eq(mediaAssets.userId, job.userId), eq(mediaAssets.kind, "cover")));
      await tx.update(mediaAssets).set({ status: "ready", ...stored, width: 1080, height: 1440, error: null }).where(eq(mediaAssets.id, asset.id));
      await tx.update(drafts).set({
        images: [{ url: stored.url, assetId: asset.id, width: 1080, height: 1440 },
          ...current.images.filter(i => i.assetId !== previousId && i.assetId !== asset.id)],
        imagesVersion: current.imagesVersion + 1, coverState: "ready", coverAssetId: asset.id, coverError: null, updatedAt: deps.now(),
      }).where(eq(drafts.id, draft.id));
    });
    await done();
  } catch (error) {
    const attempts = (p.attempts ?? 0) + 1;
    const message = error instanceof Error ? error.message : "封面生成失败";
    await deps.db.update(mediaAssets).set({ status: attempts < 3 ? "queued" : "failed", error: message })
      .where(and(eq(mediaAssets.id, asset.id), inArray(mediaAssets.status, ["queued", "processing"])));
    await deps.db.update(drafts).set({ coverState: attempts < 3 ? "queued" : "failed", coverError: message })
      .where(and(eq(drafts.id, draft.id), eq(drafts.coverRevision, p.revision)));
    await deps.db.update(jobs).set({
      status: attempts < 3 ? "queued" : "failed", payload: { ...p, attempts }, error: message,
      dueAt: new Date(deps.now().getTime() + attempts * 30_000),
    }).where(eq(jobs.id, job.id));
  }
}
