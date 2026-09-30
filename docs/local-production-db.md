# 本地连接线上数据库

本机全局 skill：`$connect-v2media-server`。私钥保存在用户 `.ssh`，数据库凭据保存在被 Git 忽略的 `apps/server/.env`。

PowerShell 启动隧道：

```powershell
& "$env:USERPROFILE/.codex/skills/connect-v2media-server/scripts/connect.ps1" -Action db
```

本地 `127.0.0.1:54330` 转发到 `ubuntu@40.160.139.134` 的 `127.0.0.1:5433`。本地 `.env` 的 DATABASE_URL 使用实际数据库凭据和这个本地端口，并设置：

```dotenv
SKIP_DB_MIGRATIONS=1
DISABLE_MEDIA_MAINTENANCE=1
```

这两个开关仅关闭启动迁移和后台媒体维护。本地页面的业务新增、修改、删除、AI 和发布操作仍会作用于生产数据。AI 配置按需另行设置，R2 凭据不自动复制。

```powershell
npm ci
npm run dev:server
# 另一个终端
npm run dev:web
```

页面：http://127.0.0.1:5173；健康检查：http://127.0.0.1:3000/health。

本机 Chrome 加载目录为 `E:/REPORT/xhscollection`。`apps/extension/.env` 的
`EXT_INSTALL_DIR` 指向此目录；`npm run build:ext` 会自动同步新文件。
构建后在 Chrome 扩展管理页点击「重新加载」，再刷新工作台与小红书页面。
无需每次重新下载、解压或重新选择加载目录。

```powershell
& "$env:USERPROFILE/.codex/skills/connect-v2media-server/scripts/connect.ps1" -Action status
& "$env:USERPROFILE/.codex/skills/connect-v2media-server/scripts/connect.ps1" -Action stop-db
```

没有 DATABASE_URL 时仍用本地 PGlite；测试使用内存 PGlite，不连生产库。不要提交 `.env`、私钥或密码。

## 本机 R2（2026-09-30 已启用）

用户明确授权后，已从服务器 `.env` 选择性同步 `R2_ENDPOINT`、`R2_BUCKET`、
`R2_ACCESS_KEY_ID`、`R2_SECRET_ACCESS_KEY` 和 `PUBLIC_BASE_URL` 到本地
`apps/server/.env`。凭据不输出、不提交；该文件已被 Git 忽略。

本地与线上使用同一个 `v2-media` 桶，公共媒体地址保持
`https://xhs.v2api.top`，避免共享数据库存入仅本机可达的地址。
本地服务重启后，新采集会在后台转存 R2 并回写媒体地址。
`SKIP_DB_MIGRATIONS=1`、`DISABLE_MEDIA_MAINTENANCE=1` 继续保留，
不会因本地启动而迁移生产库、扫全库或执行桶清理。

实测笔记 id 757：封面与 9 张图片全部转存，单图从本地和线上媒体接口读取均为
HTTP 200（image/webp）。旧记录如果没有媒体源地址，仍需重新采集才能补图。
