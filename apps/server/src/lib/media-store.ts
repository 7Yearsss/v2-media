import { eq, inArray } from "drizzle-orm";

import type { Deps } from "../context";
import { collectedNotes } from "../db/schema";
import { env } from "../env";
import type { R2Storage } from "./r2";

/** xhscdn 图片需要 Referer；只允许拉白名单域。 */
export const MEDIA_SRC_ALLOWED =
  /(^|\.)xhscdn\.com$|(^|\.)xiaohongshu\.com$/;

const OBJECT_PREFIX = "/api/media/objects/";

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * 把一张远程图转存到 R2，返回本站可直连的 /api/media/objects/<key> 绝对地址。
 * 未配 R2 / 非白名单域 / 拉取失败时原样返回旧 URL（降级为代理转发）。
 */
async function storeRemoteImage(
  r2: R2Storage | null | undefined,
  url: string,
  base: string,
): Promise<string> {
  if (!r2 || !url) return url;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return url;
  }
  if (!MEDIA_SRC_ALLOWED.test(host)) return url;
  const key = `img/${await sha256Hex(url)}`;
  try {
    if (!(await r2.head(key))) {
      const res = await fetch(url, {
        headers: { Referer: "https://www.xiaohongshu.com/" },
        signal: AbortSignal.timeout(10_000),
      }).catch(() => null);
      if (!res?.ok) return url;
      await r2.put(
        key,
        await res.arrayBuffer(),
        res.headers.get("content-type") ?? "image/jpeg",
      );
    }
  } catch {
    return url;
  }
  return `${base}${OBJECT_PREFIX}${key}`;
}

/** 图片地址的对外 base：优先 PUBLIC_BASE_URL，否则用请求 origin（nginx 透传 Host）。 */
export function publicBase(requestUrl: string): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  try {
    return new URL(requestUrl).origin;
  } catch {
    return "";
  }
}

/**
 * 采集入库后后台跑：把 cover + images 里的 xhscdn 链接转存 R2 并回写该行。
 * 已转存的（本站 objects 路径）与非白名单地址跳过。
 */
export async function persistCollectedMedia(
  deps: Deps,
  noteIds: number[],
  base: string,
): Promise<void> {
  if (!deps.r2 || !noteIds.length || !base) return;
  const rows = await deps.db
    .select()
    .from(collectedNotes)
    .where(inArray(collectedNotes.id, noteIds));
  for (const row of rows) {
    const cover = await storeRemoteImage(deps.r2, row.cover, base);
    const images = await Promise.all(
      (row.images ?? []).map(async (i) => ({
        ...i,
        url: await storeRemoteImage(deps.r2, i.url, base),
      })),
    );
    const changed =
      cover !== row.cover ||
      images.some((img, i) => img.url !== row.images?.[i]?.url);
    if (changed) {
      await deps.db
        .update(collectedNotes)
        .set({ cover, images })
        .where(eq(collectedNotes.id, row.id));
    }
  }
}
