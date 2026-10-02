import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { IMAGE_UPLOAD_LIMITS } from "@v2media/shared";
import type { Deps } from "../context";
import { mediaAssets } from "../db/schema";
import { env } from "../env";
import { assertWritable } from "./runtime-policy";

/** Shared upload/cover storage path. Returns null when the user canceled the asset. */
export async function storeCreatedMedia(
  deps: Deps, userId: number, assetId: number, prefix: "upload" | "cover", bytes: Buffer, mime: string, base: string,
) {
  assertWritable(deps);
  if (!deps.r2) throw new Error("未配置图片存储，请配置 R2 后重试");
  if (bytes.length > IMAGE_UPLOAD_LIMITS.bytes) throw new Error("处理后的图片超过 10MiB，请缩短内容或缩小底图");
  if (!/^https?:\/\//.test(base)) throw new Error("未配置有效的图片访问地址");
  const key = prefix + "/" + createHash("sha256").update(String(userId) + ":").update(bytes).digest("hex");
  const [reserved] = await deps.db.update(mediaAssets).set({ key })
    .where(and(eq(mediaAssets.id, assetId), eq(mediaAssets.userId, userId), eq(mediaAssets.status, "processing"))).returning();
  if (!reserved) return null;
  if (!(await deps.r2.head(key))) {
    const objects = (await Promise.all(["img/", "vid/", "avatar/", "upload/", "cover/"].map(p => deps.r2!.list(p)))).flat();
    if (env.r2MaxBytes > 0 && objects.reduce((n, o) => n + o.size, 0) + bytes.length > env.r2MaxBytes)
      throw new Error("图片存储容量不足，请联系管理员扩容");
    await deps.r2.put(key, Uint8Array.from(bytes).buffer, mime);
  }
  return { key, url: base.replace(/\/$/, "") + "/api/media/objects/" + key };
}
