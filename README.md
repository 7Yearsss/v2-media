# v2-media

一站式小红书运营平台：账号托管 / 插件采集 / AI 改写 / 一键发布。

## 结构

npm workspaces + TypeScript 全栈：

- `apps/server` — Hono + Drizzle；开发默认内嵌 PGlite，生产用 `DATABASE_URL` 指向 Postgres
- `apps/web` — React 19 + Vite + Tailwind 4 + beUI 动效组件（`src/components/{motion,agents,charts,previews}`）
- `apps/extension` — Chrome MV3 插件：主页嗅探采集 + creator 发布页自动化
- `packages/shared` — 三端共享的类型、xhs 响应解析器、web↔ext bridge 协议

接口契约见 [docs/api-contract.md](docs/api-contract.md)，产品/技术调研见 [docs/product-plan.md](docs/product-plan.md)、[docs/tech-direction.md](docs/tech-direction.md)、[docs/design.md](docs/design.md)。

## 开发

```bash
npm install

# 服务端（默认 http://127.0.0.1:3000，PGlite 数据在 apps/server/data/）
npm run dev:server

# 工作台前端（http://localhost:5173，/api 已代理到 3000）
npm run dev:web

# Chrome 插件构建到 apps/extension/dist/，chrome://extensions 加载该目录
npm run build:ext
```

服务端环境变量见 `apps/server/.env.example`（AI 网关、Postgres 等）。

## 验证

```bash
npm run typecheck   # 全部 workspace
npm test            # 服务端 vitest（内存 PGlite，不依赖外部服务）
npm run build:ext   # 插件构建
```

## 数据流

浏览器插件（用户已登录的小红书页面）→ 嗅探/`__INITIAL_STATE__` 采集 → `/api/ext/collect` 入内容库 → 工作台 AI 改写成草稿 → `/api/publish` 建任务 → 插件轮询 `/api/ext/publish/pending` 领取 → creator 发布页 UI 自动化 → `/api/ext/publish/:id/result` 回写。全程不逆向签名——采集与发布都发生在用户自己的浏览器里。
