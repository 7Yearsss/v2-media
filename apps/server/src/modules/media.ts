import { Hono } from "hono";

/** xhscdn 图片需要 Referer；代理转发，只允许白名单域。 */
const ALLOWED = /(^|\.)xhscdn\.com$|(^|\.)xiaohongshu\.com$/;

export function mediaModule() {
  const app = new Hono();

  app.get("/proxy", async (c) => {
    const url = c.req.query("url") ?? "";
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return c.json({ error: "bad url" }, 400);
    }
    if (target.protocol !== "https:" || !ALLOWED.test(target.hostname))
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

  return app;
}
