#!/usr/bin/env bash
# 服务器侧部署：cd ~/apps/v2-media && bash scripts/deploy-remote.sh
set -euo pipefail
cd "$(dirname "$0")/.."
npm install --no-audit --no-fund
npm run build -w @v2media/web
bash scripts/package-extension.sh
sudo -n systemctl restart v2-media
sleep 2
curl -sf http://127.0.0.1:3000/health && echo " v2-media OK"
