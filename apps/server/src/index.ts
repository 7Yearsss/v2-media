import { serve } from "@hono/node-server";

import { createApp } from "./app";
import { createDb } from "./db";
import { migrate } from "./db/migrate";
import { env } from "./env";
import { createR2 } from "./lib/r2";
import { createOpenAiClient } from "./modules/ai";

async function main() {
  const db = await createDb();
  await migrate(db);
  const app = createApp({
    db,
    ai: createOpenAiClient(),
    r2: createR2(),
    now: () => new Date(),
  });
  serve({ fetch: app.fetch, port: env.port }, (info) => {
    console.log(`v2-media server listening on http://127.0.0.1:${info.port}`);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
