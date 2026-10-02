import { and, eq } from "drizzle-orm";
import type { MediaAsset } from "@v2media/shared";
import type { Db } from "../db";
import { mediaAssets } from "../db/schema";

export function assetDto(a: typeof mediaAssets.$inferSelect): MediaAsset {
  return { id: a.id, draftId: a.draftId, filename: a.filename, status: a.status as MediaAsset["status"],
    url: a.url, width: a.width, height: a.height, error: a.error };
}

export async function draftWithUploads(db: Db, draft: typeof import("../db/schema").drafts.$inferSelect) {
  const assets = await db.select().from(mediaAssets).where(and(eq(mediaAssets.userId, draft.userId), eq(mediaAssets.draftId, draft.id)));
  return { ...draft, uploads: assets.filter(a => draft.images.some(i => i.assetId === a.id)).map(assetDto) };
}
