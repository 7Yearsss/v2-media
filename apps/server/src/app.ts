import { existsSync } from "node:fs";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { cors } from "hono/cors";

import type { Deps } from "./context";
import { accountsModule } from "./modules/accounts";
import { aiModule } from "./modules/ai";
import { authMiddleware, authModule } from "./modules/auth";
import { draftsModule } from "./modules/drafts";
import { extModule } from "./modules/ext";
import { mediaModule } from "./modules/media";
import { notesModule } from "./modules/notes";
import { overviewModule } from "./modules/overview";
import { publishModule } from "./modules/publish";

export function createApp(deps: Deps) {
  const app = new Hono();

  app.use("/api/*", cors());
  app.get("/health", (c) => c.json({ ok: true }));

  app.route("/api/auth", authModule(deps));

  // 媒体代理/R2 对象要能被 <img> 直接拉取，挂在没有 Bearer 鉴权的区域
  app.route("/api/media", mediaModule(deps));

  const secured = new Hono<{ Variables: { userId: number } }>();
  secured.use("*", authMiddleware);
  secured.route("/accounts", accountsModule(deps));
  secured.route("/notes", notesModule(deps));
  secured.route("/drafts", draftsModule(deps));
  secured.route("/ai", aiModule(deps));
  secured.route("/publish", publishModule(deps));
  secured.route("/overview", overviewModule(deps));
  secured.route("/ext", extModule(deps));
  app.route("/api", secured);

  // 生产模式：直接托管 apps/web/dist（单进程部署，nginx 反代一个端口即可）
  const webDist = new URL("../../web/dist/", import.meta.url).pathname;
  if (existsSync(webDist)) {
    app.use(
      "/*",
      serveStatic({
        root: webDist,
        rewriteRequestPath: (p) => p,
      }),
    );
    // SPA fallback：非 /api 的 GET 全部回 index.html
    app.get("*", (c, next) => {
      if (c.req.path.startsWith("/api/") || c.req.path === "/health") return next();
      return serveStatic({ root: webDist, path: "index.html" })(c, next);
    });
  }

  return app;
}
