import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import path from "node:path";
import { createReadStream, existsSync } from "node:fs";

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: "local-extension-download",
      configureServer(server) {
        server.middlewares.use("/extension.zip", (_req, res) => {
          const file = path.resolve(__dirname, "../extension/dist/extension.zip");
          if (!existsSync(file)) {
            res.statusCode = 503;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
            res.end("插件尚未构建，请先运行 npm run build:ext");
            return;
          }
          res.setHeader("Content-Type", "application/zip");
          res.setHeader("Content-Disposition", 'attachment; filename="v2-media-extension.zip"');
          res.setHeader("Cache-Control", "no-store");
          const stream = createReadStream(file);
          stream.on("error", () => res.destroy());
          stream.pipe(res);
        });
      },
    },
  ],
  resolve: {
    alias: { "@": path.resolve(__dirname, "src") },
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: { "/api": "http://127.0.0.1:3000" },
  },
});
