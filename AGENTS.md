# AGENTS.md

先读 `docs/product-plan.md`（技术方向调研）与 `docs/api-contract.md`（接口契约）。

## 结构

npm workspaces，TypeScript 全栈：
- `apps/server` — Hono + Drizzle（PGlite dev / Postgres prod），模块在 `src/modules/`，依赖经 `Deps`（`src/context.ts`）注入；测试 vitest + 内存 PGlite，不连外网（AI 走 mock fetch 注入）
- `apps/web` — React 19 + Vite + Tailwind v4 + vendored beUI（`src/components/{motion,agents,charts,blocks}`，源 mcp.beui.dev）；设计方向见 `docs/design.md`
- `apps/extension` — Chrome MV3，esbuild 打包；`main-world` 嗅探 XHS 页面数据（机制见 `docs/xhs-extension-research.md`）
- `packages/shared` — 三端共享类型 + 小红书解析器 + 桥协议；**改契约先改这里**

## 约定

- 平台差异（XHS 是第一个）只写在自己的适配目录里；数据按 user_id 隔离
- 慢操作（AI 调用、素材下载）进 server 的 jobs 机制，不在请求里同步等外部服务
- 页面数据解析用 `@v2media/shared/xhs-parse` 的纯函数，不要把小红书原始字段泄漏到业务代码
- 插件在站点页面注入 UI 一律用 Shadow DOM 浮层，不改站点 DOM
- secrets 只走 .env / UI 入库，不进代码与提交

## 验证

- `npm run typecheck`（全仓）· `npm test`（server）· `npm run build:ext`
- dev：`npm run dev:server`（:3000）+ `npm run dev:web`（:5173）+ `npm run build:ext` 后 chrome://extensions 加载 `apps/extension/dist`

## AI 分析

- `POST /api/collections/:id/analyze` 是异步的：立刻 202 + `status=running` 行（已含代码算好的信号），后台跑 AI，页面轮询详情到 done/failed；running 超 12 分钟读取时回收为 failed。Cloudflare 对 >100s 无响应的请求返回 524，所以不能同步等，AI 客户端也用流式。
- 提示词在 `src/lib/analysis-prompts.ts`，原则：最短 + 说明原因，只为评测失败加内容；评分器 `src/lib/analysis-grader.ts`，真模型评测 `npx tsx apps/server/scripts/eval-analysis.ts`。
- `AI_ANALYSIS_MODEL` 可单独指定分析用模型（空=`AI_MODEL`）；慢的推理模型会很久，选响应快的。

## 生产部署

- 线上： https://xhs.v2api.top → nginx → 127.0.0.1:3000（systemd `v2-media`，目录 `~/apps/v2-media`，Postgres 走 `v2media-postgres` docker on 127.0.0.1:5433）
- CI：push/merge 到 main 触发 `.github/workflows/deploy.yml`（build web + `scripts/package-extension.sh` 打插件 zip → rsync → npm install → `systemctl restart`）；仓库需配 secrets `SSH_PRIVATE_KEY`/`SSH_HOST`/`SSH_USER`/`SSH_KNOWN_HOSTS`
- 媒体存 Cloudflare R2 桶 `v2-media`（采集后后台把 xhscdn 图转存，DB 存 `/api/media/objects/<key>` 绝对 URL）；没配 `R2_*` 环境变量时降级为实时代理。视频同样转存（`vid/`），单个上限 `MEDIA_VIDEO_MAX_BYTES`（默认 80MB，pro 档 `MEDIA_VIDEO_MAX_BYTES_PRO` 默认 200MB），主流超限时退到 `raw_json.video.fallbackUrls` 里更小的清晰度，都超限则保留原链；桶总量上限 `R2_MAX_BYTES``/api/media/*` 无鉴权（要给 <img> 用），proxy 只放白名单域、objects key 是内容哈希不可枚举
- Devin 连服务器走 SSH 隧道而非公网：`ssh -i ~/.ssh/v2media_actions -L 3000:127.0.0.1:3000 ubuntu@40.160.139.134` 后访问 localhost:3000；服务器在共享生产机上，勿动其他 nginx vhost / docker 容器
