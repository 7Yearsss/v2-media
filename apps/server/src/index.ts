import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createDb } from "./db";
import { assertSchemaCurrent, migrate } from "./db/migrate";
import { env } from "./env";
import { pruneMedia, sweepMediaBacklog } from "./lib/media-store";
import { createR2 } from "./lib/r2";
import { startMediaWorker } from "./lib/media-jobs";
import { startUploadWorker } from "./lib/upload-jobs";
import { startDraftWorker } from "./lib/draft-jobs";
import { startPostmortemWorker } from "./lib/postmortem-jobs";
import { startAiWorker } from "./lib/ai-runs";
import { createAiRunHandlers } from "./lib/ai-run-handlers";
import { createOpenAiClient } from "./modules/ai";

async function main() {
  const db = await createDb();
  if (env.runtimeMode === "local-isolated") await migrate(db, { runtimeMode: env.runtimeMode });
  await assertSchemaCurrent(db);
  const r2 = createR2();
  const deps = {
    db,
    ai: createOpenAiClient(),
    r2,
    now: () => new Date(),
    runtimeMode: env.runtimeMode,
  };
  const app = createApp(deps);
  if (env.runtimeMode !== "production-readonly") {
    startAiWorker(deps, createAiRunHandlers(deps));
    startPostmortemWorker(deps);
    if (r2) startMediaWorker(deps);
    if (r2) startUploadWorker(deps);
    if (r2) startDraftWorker(deps);
  }
  // 启动兜底：上次进程退出可能把媒体转存打断，扫一遍外链残留补转存
  if (env.runtimeMode !== "production-readonly" && !env.disableMediaMaintenance) {
    void sweepMediaBacklog(deps).catch((err) =>
      console.warn("media sweep failed:", err),
    );
  }
  // 媒体 GC：清理无引用对象 + 桶容量上限（R2_MAX_BYTES）
  if (env.runtimeMode !== "production-readonly" && r2 && !env.disableMediaMaintenance) {
    const gc = () =>
      pruneMedia(deps).catch((err) => console.warn("media gc failed:", err));
    void gc();
    setInterval(gc, Math.max(5, env.mediaGcMinutes) * 60_000).unref();
  }
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`v2-media server listening on http://127.0.0.1:${info.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
