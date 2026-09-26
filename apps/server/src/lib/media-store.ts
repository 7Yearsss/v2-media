import { eq, inArray, or, sql } from "drizzle-orm";
import type { HonoRequest } from "hono";

import type { Deps } from "../context";
import { collectedNotes, drafts } from "../db/schema";
import { env } from "../env";
import type { R2Storage } from "./r2";

/** xhscdn 图片需要 Referer；只允许拉白名单域。 */
export const MEDIA_SRC_ALLOWED =
  /(^|\.)xhscdn\.com$|(^|\.)xiaohongshu\.com$/;

const OBJECT_PREFIX = "/api/media/objects/";
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(s),
  );
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** 防 redirect 带出白名单：只取同源 3xx，目标重新过域名校验，否则失败。 */
export async function fetchAllowed(
  url: string,
  redirectsLeft = 3,
): Promise<Response | null> {
  let current = url;
  for (let i = 0; i <= redirectsLeft; i++) {
    const res = await fetch(current, {
      headers: { Referer: "https://www.xiaohongshu.com/" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) return null;
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return null;
      try {
        const next = new URL(loc, current);
        if (next.protocol !== "https:" || !MEDIA_SRC_ALLOWED.test(next.hostname))
          return null;
        current = next.toString();
      } catch {
        return null;
      }
      continue;
    }
    return res;
  }
  return null;
}

/**
 * 把一张远程图转存到 R2，返回本站可直连的 /api/media/objects/<key> 绝对地址。
 * key 是源 URL 的哈希（同 URL 天然幂等，重复采集不重复上传）。
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
      const res = await fetchAllowed(url);
      if (!res?.ok) return url;
      if (
        Number(res.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES
      )
        return url;
      const body = await res.arrayBuffer();
      if (body.byteLength > MAX_IMAGE_BYTES) return url;
      await r2.put(
        key,
        body,
        res.headers.get("content-type") ?? "image/jpeg",
      );
    }
  } catch {
    return url;
  }
  return `${base}${OBJECT_PREFIX}${key}`;
}

/**
 * 图片地址的对外 base：优先 PUBLIC_BASE_URL；否则用 Host + 可信的
 * X-Forwarded-Proto（nginx 反代会设）重建 https origin，避免存出 http://
 * 混合内容地址。
 */
export function publicBase(req: HonoRequest): string {
  if (env.publicBaseUrl) return env.publicBaseUrl;
  try {
    const url = new URL(req.url);
    const proto = req.header("x-forwarded-proto") ?? url.protocol.replace(":", "");
    return `${proto}://${url.host}`;
  } catch {
    return "";
  }
}

/**
 * 采集入库后后台跑：把 cover + images 里的 xhscdn 链接转存 R2 并回写该行。
 * 回写带 CAS 条件（字段仍等于快照才写），并发采集不会让旧快照覆盖新图集；
 * 由后到的 collect 触发的下一轮 persist 会补漏。
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
    if (!changed) continue;
    // CAS：仅当 cover/images 仍等于我们读取时的快照才回写，防并发 collect 互相覆盖
    await deps.db
      .update(collectedNotes)
      .set({
        cover,
        images,
      })
      .where(
        sql`${collectedNotes.id} = ${row.id}
            AND ${collectedNotes.cover} = ${row.cover}
            AND ${collectedNotes.images}::jsonb = ${JSON.stringify(row.images)}::jsonb`,
      );
  }
}

/**
 * 启动兜底：扫一遍仍带 xhscdn/xiaohongshu 外链的行重跑转存，
 * 覆盖上一次进程退出/部署中断留下的半成品。需要 PUBLIC_BASE_URL。
 */
export async function sweepMediaBacklog(deps: Deps): Promise<void> {
  if (!deps.r2 || !env.publicBaseUrl) return;
  const rows = await deps.db
    .select({ id: collectedNotes.id })
    .from(collectedNotes)
    .where(
      or(
        sql`${collectedNotes.cover} ~ 'xhscdn|xiaohongshu'`,
        sql`${collectedNotes.images}::text ~ 'xhscdn|xiaohongshu'`,
      ),
    )
    .limit(500);
  if (!rows.length) return;
  console.log(`media sweep: ${rows.length} notes to migrate to R2`);
  await persistCollectedMedia(
    deps,
    rows.map((r) => r.id),
    env.publicBaseUrl,
  );
}

const OBJECT_KEY_RE = /\/api\/media\/objects\/(img\/[0-9a-f]{64})/g;

/** DB 里仍被引用的 R2 对象 key 集合（采集表 cover/images + 草稿表 images）。 */
async function referencedKeys(deps: Deps): Promise<Set<string>> {
  const keys = new Set<string>();
  const notes = await deps.db
    .select({ cover: collectedNotes.cover, images: collectedNotes.images })
    .from(collectedNotes);
  const draftRows = await deps.db
    .select({ images: drafts.images })
    .from(drafts);
  const urls: string[] = [];
  for (const n of notes) {
    urls.push(n.cover, ...(n.images ?? []).map((i) => i.url));
  }
  for (const d of draftRows) {
    urls.push(...(d.images ?? []).map((i) => i.url));
  }
  for (const u of urls) {
    for (const m of u.matchAll(OBJECT_KEY_RE)) keys.add(m[1]!);
  }
  return keys;
}

/**
 * 媒体 GC（开发期容量控制）：删 DB 已无引用的对象；仍超 R2_MAX_BYTES 时
 * 按最旧优先删引用中的对象（腾出容量，对应行会残留失效图，开发期可接受）。
 */
export async function pruneMedia(deps: Deps): Promise<void> {
  if (!deps.r2) return;
  const objects = await deps.r2.list("img/");
  if (!objects.length) return;
  const referenced = await referencedKeys(deps);
  // 宽限期：对象刚 PUT 而 persist 的 DB 回写还在路上时，不能被当无引用删掉
  const graceBefore = Date.now() - 10 * 60_000;
  let removed = 0;
  const kept: typeof objects = [];
  for (const o of objects) {
    if (!referenced.has(o.key) && o.lastModified < graceBefore) {
      if (await deps.r2.delete(o.key).catch(() => false)) removed++;
      else kept.push(o);
    } else {
      kept.push(o);
    }
  }
  let total = kept.reduce((s, o) => s + o.size, 0);
  const cap = env.r2MaxBytes;
  if (cap > 0 && total > cap) {
    kept.sort((a, b) => a.lastModified - b.lastModified);
    for (const o of kept) {
      if (total <= cap) break;
      // 删除失败不扣容量——失败的对象还占着桶
      if (await deps.r2!.delete(o.key).catch(() => false)) {
        total -= o.size;
        removed++;
      }
    }
  }
  if (removed)
    console.log(`media gc: removed ${removed} objects (${kept.length} kept)`);
}
