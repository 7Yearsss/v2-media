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
