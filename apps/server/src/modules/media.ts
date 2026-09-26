import { Hono } from "hono";

import type { Deps } from "../context";
import { MEDIA_SRC_ALLOWED } from "../lib/media-store";

/**
 * 媒体路由挂在未鉴权区域：<img> 标签发不出 Authorization 头。
 * proxy 只允许白名单域；objects 的 key 是内容哈希，不可枚举。
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
    const res = await fetch(target, {
      headers: { Referer: "https://www.xiaohongshu.com/" },
    }).catch(() => null);
    if (!res || !res.ok) return c.json({ error: "fetch failed" }, 502);
    const buf = await res.arrayBuffer();
    return new Response(buf, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=86400",
      },
    });
  });

  // R2 转存对象：GET /api/media/objects/img/<hash>
  app.get("/objects/*", async (c) => {
    const key = c.req.path.slice(c.req.path.indexOf("/objects/") + 9);
    if (!deps.r2 || !key) return c.json({ error: "not found" }, 404);
    const res = await deps.r2.get(key);
    if (!res) return c.json({ error: "not found" }, 404);
    return new Response(res.body, {
      headers: {
        "Content-Type": res.headers.get("content-type") ?? "image/jpeg",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
}
