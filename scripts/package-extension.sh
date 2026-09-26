#!/usr/bin/env bash
# 生产插件打包：build:ext:prod（把 xhs.v2api.top 烘进 manifest）→ zip 进 apps/web/dist
# 必须在 `npm run build -w @v2media/web` 之后跑（vite 会清空 dist）
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build:ext:prod
mkdir -p apps/web/dist
rm -f apps/web/dist/extension.zip
(cd apps/extension/dist && zip -qr ../../web/dist/extension.zip .)
echo "extension.zip -> apps/web/dist/extension.zip"
