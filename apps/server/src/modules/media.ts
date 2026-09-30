import { Hono } from "hono";

import type { Deps } from "../context";
import { fetchAllowed, MEDIA_SRC_ALLOWED } from "../lib/media-store";

/**
 * 媒体路由挂在未鉴权区域：<img> 标签发不出 Authorization 头。
 * proxy 只允许白名单域、手动跟随重定向并逐个校验目标；
 * objects 只认 img|vid/<hash> 形态的 key，不可枚举、不可读桶内其他对象。
 */
export function mediaModule(deps: Deps) {
  const app = new Hono();

  app.get("/proxy", async (c) => {
    const url = c.req.query("url") ?? "";
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return c.json({ error: "bad url" }, 400);
    }
    if (target.protocol !== "https:" || !MEDIA_SRC_ALLOWED.test(target.hostname))
      return c.json({ error: "host not allowed" }, 403);
    // 流式透传（不整包缓冲）；fetchAllowed 内校验每次重定向目标
    const res = await fetchAllowed(target.toString());
    if (!res || !res.ok) return c.json({ error: "fetch failed" }, 502);
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // R2 转存对象：GET /api/media/objects/(img|vid)/<64-hex>（限定前缀+哈希形态）
  app.get("/objects/*", async (c) => {
    const key = c.req.path.slice(c.req.path.indexOf("/objects/") + 9);
    if (!deps.r2 || !/^(img|vid|avatar)\/[0-9a-f]{64}(-(sd|orig))?$/.test(key))
      return c.json({ error: "not found" }, 404);
    // Range 透传：视频 seek 需要 206 + Content-Range，不能整包返回
    const range = c.req.header("range");
    const res = await deps.r2.get(key, range);
    if (!res) return c.json({ error: "not found" }, 404);
    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
    };
    for (const h of ["content-range", "content-length"])
      if (res.headers.get(h)) headers[h] = res.headers.get(h)!;
    return new Response(res.body, { status: res.status, headers });
  });

  return app;
}
