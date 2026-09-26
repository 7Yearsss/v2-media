import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

/**
 * Web-app origins the extension trusts (site-bridge + API calls), comma
 * separated. Dev default is the Vite server, which proxies /api.
 *   EXT_APP_ORIGINS=https://app.example.com npm run build:ext
 */
const origins = (process.env.EXT_APP_ORIGINS ?? "http://localhost:5173,http://127.0.0.1:5173")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

/**
 * API origins the service worker may fetch (apiBase from SET_AUTH).
 * Dev default is the Hono server.
 *   EXT_API_ORIGINS=https://api.example.com npm run build:ext
 */
const apiOrigins = (process.env.EXT_API_ORIGINS ?? "http://127.0.0.1:3000,http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/$/, ""))
  .filter(Boolean);

for (const o of [...origins, ...apiOrigins]) {
  if (!/^https?:\/\/[^/]+$/.test(o)) throw new Error(`bad origin: ${o}`);
}

await build({
  bundle: true,
  format: "iife",
  target: "chrome120",
  outdir: "dist",
  entryPoints: {
    background: "src/background.ts",
    content: "src/content.ts",
    "xhs-main": "src/main-world/xhs.ts",
    "creator-publish": "src/creator-publish.ts",
    "site-bridge": "src/site-bridge.ts",
    popup: "src/popup.ts",
  },
});

cpSync("static", "dist", { recursive: true });
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
const patterns = origins.map((o) => `${o}/*`);
manifest.host_permissions.push(...patterns, ...apiOrigins.map((o) => `${o}/*`));
manifest.content_scripts.find((cs) => cs.js.includes("site-bridge.js")).matches = patterns;
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));
console.log(`extension built -> dist/ (app origins: ${origins.join(", ")})`);
