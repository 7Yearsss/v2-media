import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";
import { zipSync } from "fflate";

// 本机加载目录等偏好保存在被 Git 忽略的 .env。
if (existsSync(".env")) process.loadEnvFile(".env");

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
    "creator-main": "src/main-world/creator.ts",
    "creator-tasks": "src/creator-tasks.ts",
    "creator-publish": "src/creator-publish.ts",
    "site-bridge": "src/site-bridge.ts",
    popup: "src/popup.ts",
  },
});

cpSync("static", "dist", { recursive: true });
const manifest = JSON.parse(readFileSync("static/manifest.json", "utf8"));
const patterns = origins.map((o) => `${o}/*`);
manifest.host_permissions = [
  ...new Set([
    ...manifest.host_permissions,
    ...patterns,
    ...apiOrigins.map((o) => `${o}/*`),
  ]),
];
manifest.content_scripts.find((cs) => cs.js.includes("site-bridge.js")).matches = patterns;
writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));
// 同步生成可下载包，manifest 必须在压缩包根目录。
const zipFiles = {};
function addFiles(dir, prefix = "") {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = `${prefix}${entry.name}`;
    if (name === "extension.zip") continue;
    if (entry.isDirectory()) addFiles(join(dir, entry.name), `${name}/`);
    else zipFiles[name] = new Uint8Array(readFileSync(join(dir, entry.name)));
  }
}
addFiles("dist");
writeFileSync("dist/extension.zip", zipSync(zipFiles));
if (process.env.EXT_INSTALL_DIR) {
  const installDir = resolve(process.env.EXT_INSTALL_DIR);
  if (installDir !== resolve("dist")) {
    cpSync("dist", installDir, { recursive: true });
    console.log(`extension synced -> ${installDir}`);
  }
}
console.log(`extension built -> dist/ (app origins: ${origins.join(", ")})`);
