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

  const secured = new Hono<{ Variables: { userId: number } }>();
  secured.use("*", authMiddleware);
  secured.route("/accounts", accountsModule(deps));
  secured.route("/notes", notesModule(deps));
  secured.route("/drafts", draftsModule(deps));
  secured.route("/ai", aiModule(deps));
  secured.route("/publish", publishModule(deps));
  secured.route("/overview", overviewModule(deps));
  secured.route("/ext", extModule(deps));
  secured.route("/media", mediaModule());
  app.route("/api", secured);

  return app;
}
