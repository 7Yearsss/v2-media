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
- 慢操作（AI 调用、素材下载）进 server 的持久任务机制，不在请求里同步等外部服务；分析/选题/深评使用 `ai_runs`，素材/成稿/封面等继续使用 `jobs`
- 页面数据解析用 `@v2media/shared/xhs-parse` 的纯函数，不要把小红书原始字段泄漏到业务代码
- 插件在站点页面注入 UI 一律用 Shadow DOM 浮层，不改站点 DOM
- secrets 只走 .env / UI 入库，不进代码与提交

## 验证

- 运行模式 `V2MEDIA_RUNTIME_MODE` 默认 `local-isolated`，拒绝 `DATABASE_URL`；不要用主目录生产 `.env` 启动开发服务。`production-readonly` 要用专用只读 PG 角色且无 worker/迁移；`production-worker` 必须显式配置生产密钥。具体配置见 `docs/r2-history-runtime-verification.md`。
- 生产启动只检查迁移账本与 schema。使用 `npm run db:status -w @v2media/server` 及同工作区的 `db:check`、`db:duplicates`、`db:migrate` 显式命令；新结构追加版本，不修改已发布迁移或 checksum。重复账号迁移失败时保留全部行，不自动合并/删除。
- 账号解绑/草稿删除是可恢复归档，不物理删除发布证据；`archivedAt` 控制活跃列表及新执行，历史回采/指标/复盘保留。自动心跳不恢复归档账号。

- `npm run typecheck`（全仓）· `npm test`（server）· `npm run build:ext`
- dev：`npm run dev:server`（:3000）+ `npm run dev:web`（:5173）+ `npm run build:ext` 后 chrome://extensions 加载 `apps/extension/dist`

## 持久 AI 任务（R3）

- `POST /api/collections/:id/analyze` 在同一事务创建 `CollectionAnalysis(status=running,aiRunId)` 和 `ai_runs`，立即 202（已含代码信号）。`POST /api/ai/topics|topic-score` 立即 202 + 公共 `AiRun`，结果通过 `GET /api/ai/runs/:id` 及原领域接口读取，不再同步返回选题列表或评分正文。创建可带 UUID `operationId`；同用户相同操作/请求返回原任务，不重新冻结输入，换请求复用 ID 返回 409。
- worker 在 `src/lib/ai-runs.ts`，领域适配器在 `analysis-ai-run.ts` / `topic-ai-run.ts`。必须冻结样本、人设、原选题版本、模型与提示词，再排队；禁止请求内 `void` 闭包启动 AI。租约 2 分钟、20 秒续租、单 attempt 最长 12 分钟；worker 回收过期租约并按 30s/60s 退避，初始最多 3 次。进度、终态和领域写入均校验租约/attempt，领域结果与 done 同事务提交，迟到模型不能覆盖新代次或已停止结果。新 run 的 GET 仅观测，不回收任务；旧无 aiRunId 的分析保留原超时兼容规则。
- `POST /api/ai/runs/:id/retry {operationId:UUID}` 重试失败任务，沿用冻结输入且 attempt 继续递增；持久重试命令收据防止 ACK 丢失后再次排队。同 ID 换目标 409。`/cancel` 停止 queued/running 并清租约，不保证撤回已送到模型服务的请求。账号归档增加内部执行代次，恢复不重新授权旧 AI 结果。选题编辑/来源删除或移库/人设变化会阻止旧评分或选题写入；七维缺失或非法输出必须 failed，不能补 5 分伪造评分。
- schema 当前为版本 3 `durable-ai-runs`；生产先运行显式迁移，再启动服务。只追加迁移，不改已应用版本 1/2 的 statements/checksum；生产只读模式不启动 AI worker。
- Cloudflare 对 >100s 无响应的请求返回 524，所以这些入口不等待模型；AI 客户端仍用流式。
- 提示词在 `src/lib/analysis-prompts.ts`，原则：最短 + 说明原因，只为评测失败加内容；评分器 `src/lib/analysis-grader.ts`，真模型评测 `npx tsx apps/server/scripts/eval-analysis.ts`。
- `AI_ANALYSIS_MODEL` 可单独指定分析用模型（空=`AI_MODEL`）；慢的推理模型会很久，选响应快的。

## 生产部署

- 线上： https://xhs.v2api.top → nginx → 127.0.0.1:3000（systemd `v2-media`，目录 `~/apps/v2-media`，Postgres 走 `v2media-postgres` docker on 127.0.0.1:5433）
- CI：push/merge 到 main 触发 `.github/workflows/deploy.yml`（build web + `scripts/package-extension.sh` 打插件 zip → rsync → npm install → `systemctl restart`）；仓库需配 secrets `SSH_PRIVATE_KEY`/`SSH_HOST`/`SSH_USER`/`SSH_KNOWN_HOSTS`
- 媒体存 Cloudflare R2 桶 `v2-media`（采集后后台把 xhscdn 图转存，DB 存 `/api/media/objects/<key>` 绝对 URL）；没配 `R2_*` 环境变量时降级为实时代理。视频同样转存（`vid/`），单个上限 `MEDIA_VIDEO_MAX_BYTES`（默认 80MB，pro 档 `MEDIA_VIDEO_MAX_BYTES_PRO` 默认 200MB），主流超限时退到 `raw_json.video.fallbackUrls` 里更小的清晰度，都超限则保留原链；桶总量上限 `R2_MAX_BYTES``/api/media/*` 无鉴权（要给 <img> 用），proxy 只放白名单域、objects key 是内容哈希不可枚举
- Devin 连服务器走 SSH 隧道而非公网：`ssh -i ~/.ssh/v2media_actions -L 3000:127.0.0.1:3000 ubuntu@40.160.139.134` 后访问 localhost:3000；服务器在共享生产机上，勿动其他 nginx vhost / docker 容器
