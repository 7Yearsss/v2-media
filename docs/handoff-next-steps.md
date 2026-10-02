# Handoff：下一阶段任务

2026-10-02。写给接手的 AI。先读 `AGENTS.md`，再读本文件和 `docs/publish-smoke-test.md`。

## 现状（一句话）

「插件采集 → 内容库 → AI 分析 → 选题 → AI 成稿 → 插件发布」已端到端跑通一次（PR #27，仅自己可见发布成功）。真实 readback 与首条指标已验证；T1 图片上传、T2 自动封面和 T3 账号人设已在功能分支实现，尚待部署后的真实 AI/R2/私密发布验收。

| 环节 | 状态 | 关键位置 |
|---|---|---|
| 采集 | 可用（浏览即采集、深度采集、点赞门槛） | `apps/extension/src/{content,background}.ts`、`main-world/xhs.ts` |
| AI 分析 | 可用，异步 + 评分器 | `apps/server/src/lib/analysis-*.ts`、`modules/collections.ts` |
| 选题 | 可用（AI 生成 + 七维评分） | `modules/topics.ts`、`web/src/pages/topics.tsx` |
| AI 成稿 | T2 分支实现异步成稿 + 模板封面，生产仍待部署验收 | `lib/draft-jobs.ts`、`lib/cover-render.ts` |
| 草稿图片 | T1 分支实现上传/排序/移除/重试，生产仍待验收 | `modules/media.ts`、`web/src/components/app/draft-images.tsx` |
| 插件发布 | 刚跑通 | `extension/src/creator-publish.ts` |
| 归因回采 | readback 与首条 metrics 真实落库已通过，1 天/7 天待到期 | `ext.ts` tasks、`background.ts` readback/metrics |
| 账号人设 | T3 分支实现三字段编辑/提示词注入/历史快照，生产待部署 | `lib/account-persona.ts`、`db/schema.ts` |

⚠️ 本地 `apps/server/.env` 的 `DATABASE_URL` 指向**生产库**（经 SSH 隧道 127.0.0.1:54330）。写操作都会落到线上。做开发/测试请换成本地 PGlite（去掉 `DATABASE_URL`），或明确知道自己在动生产。

## 任务（按顺序）

2026-10-02 已根据当前代码细化为 [`next-stage-plan.md`](next-stage-plan.md)：T1/T2 有契约、异步状态、素材保留与验收方案，T3–T5 有后续切片及依赖。该文件为规划，不代表实现完成。

### T0 验证归因回采（小，先做）

发布任务 `publish_jobs.id=13` 发布后自动排了 `jobs.id=85`（type=readback，due 2026-10-01T16:54Z）。确认：
- readback 是否 `done`，`publish_jobs.13.outcome` 是否 `verified`、`note_id` 是否回填
- 之后是否排出 metrics（T+1h/1d/7d）与 `note_metrics` 落库
- 不通就修，同样把失败与根因追加到 `docs/publish-smoke-test.md`

验收：`publish_jobs.13` 有 `outcome=verified` + `note_id`；`note_metrics` 至少一行。

2026-10-02 接手进展：已恢复数据库隧道并启动本地 server/web。09:50（北京时间）复查确认 readback #85 已 done，发布 #13 已 verified，note_id 已回填为 `6abe8de6000000000200f2b7`；自动排出 metrics #86/#87/#88，分别在北京时间 10 月 2 日 10:48、10 月 3 日 09:48、10 月 9 日 09:48 到期。09:50 尚无指标快照，第一条任务未到期。完整证据、启动参数与时间解释见 `docs/publish-smoke-test.md` 的「T0 接手核对」。**笔记确认已通过，T0 仍待至少一行真实指标入库。**

T0 最新结论（13:03 北京时间只读复查）：admin@devin.local（ID #2）的 metrics #86 已 done，note_metrics #1 于北京时间 10:55:39 真实入库，关联发布 #13 和已核对笔记 ID。互动四项为 0，views/exposure 未采到。T0 最小验收通过；#87/#88 的 1 天/7 天指标仍待到期。完整证据见 publish-smoke-test.md 最新段落。

### T1 草稿图片上传（P1 前置）

2026-10-02：实现已在 `codex/draft-image-upload` 分支完成，带异步上传/素材状态、排序/移除/重试、图集版本和发布快照。112 项测试、typecheck、插件与 web 构建通过；独立内存库/mock R2 验证了 3 张图片接收、处理、读取和页面图序/刷新/切换。尚未部署和执行真实 R2 → private 发布验收，不能标成完整生产验收通过。需部署新增 schema/objects 路由并配置 R2 后完成该步；详情见 `docs/t1-upload-verification.md`。

- server：`POST /api/media/upload`（需鉴权，multipart，限图片类型与大小），存 R2（复用 `lib/r2.ts`、key 用内容哈希，参考 `media-store.ts` 的存储方式），返回 `/api/media/objects/<key>` 绝对 URL；没配 R2 时的降级方案要想清楚（不能只存本地临时目录）
- web：草稿编辑区加上传（拖拽/选择，多张，可排序/删除），保留粘贴 URL
- 插件发布下载图片走 `FETCH_IMAGE`，要求 http(s) 且插件 host_permissions 覆盖——确认生产域名 `xhs.v2api.top` 下的 objects URL 能被插件抓到

验收：在草稿页上传 3 张本地图 → 创建发布任务（private）→ 插件发布成功且图片顺序正确。

### T2 同款封面生成（P1 核心）

2026-10-02：模板封面实现已在 `codex/automatic-covers`（包含 T1 提交）完成：四模板、打包中文字体、202 异步成稿和自动首图、参数编辑与重新生成。独立内存库/mock AI/R2 的页面链路已实测；Windows 四模板渲染与本地 WSL/Linux 字体探针通过。尚未推送、部署或跑真实 AI/R2 → 私密发布，验收边界和后续步骤见 `docs/t2-cover-verification.md`。

用户最大需求是「能直接发的完整笔记」，小红书封面决定点击。
- 第一版做**模板化文字封面**：输入 = AI 成稿的 `cover` 大字 + 可选用户底图 + 参照爆款的版式类型；输出 1080×1440（3:4）PNG，存 R2，写进 `draft.images[0]`
- 渲染放 server（如 `@napi-rs/canvas` / satori+resvg），字体要含中文（打包一款可商用字体，别依赖系统字体）；慢操作进 jobs 机制，不在请求里同步等
- 3–5 个模板起步（大字报、清单步骤、前后对比、单图+标题条…）；模板从采集库爆款封面的共性里挑（AI 分析已能看封面，`analysis-run.ts` 的 visual 部分）
- 成稿流程：`to-draft {ai:true}` 后自动出一张封面，草稿页可换模板/改字/重生成
- 第二版再考虑 AI 生图（OpenAI 兼容 `images/generations`，网关同 `AI_BASE_URL`）
- 冒烟测试时手写的样例封面效果可参考：深红顶栏大标题 + 白底圆角卡片列 3 步 + 底部一句钩子

验收：选题一键成稿后草稿自带一张封面，无需任何手动操作即可创建发布任务。

### T3 账号人设（P2）

2026-10-02：实现位于 `codex/account-persona`（包含 T1/T2）。账号矩阵编辑三字段，统一注入选题/成稿/改写/标题/标签/分析，保存调用快照，发布采用实际目标账号规则和版本检查。隔离内存库/mock AI/R2 已验证保存、刷新和切换账号；135 项测试（单 worker）、typecheck、插件/web 构建通过。未迁移生产库，也未编辑真实 ID #2 的人设。详见 `docs/t3-persona-verification.md`。

`hosted_accounts` 加 `positioning`（定位/内容支柱）、`style_notes`、`redlines`；账号矩阵页可编辑；选题生成、AI 成稿、AI 分析的提示词注入（现在分析/成稿已有临时 `positioning` 参数，改为默认取账号字段）；红线作为发布前自查的输入之一（违禁词检查已有）。设计见 `docs/planning-attribution-design.md` 第四节。

### T4 归因消费（P3）

2026-10-02：`codex/insights-postmortem`（包含 T1–T3）实现洞察筛选/账户趋势/逐篇时序、异步持久复盘、发布前评分快照和按账号/模型/口径/采样窗口的分组观察。143 项离线测试、typecheck、插件/web 构建通过。使用 ID #2 的真实生产记录只读快照在隔离内存库验证页面；生产未迁移/写入。当前只有一篇私密零互动笔记，不能做评分统计校准或验证真实模型复盘，详见 `docs/t4-insights-verification.md`。

洞察页（账号快照趋势 + 已发笔记表现榜）+ 单篇复盘 `/api/ai/postmortem`；并做「AI 选题评分 vs 实际表现」对照，用来校准分析与选题提示词。依赖 T0 的数据。设计同上文档第五、七节。

### T5 采集规模（P4）

2026-10-02：首切片实现位于 `codex/keyword-collection`（包含 T1–T4）：有限关键词任务、冻结规则/目标库、逐篇 checkpoint、租约撤销/恢复、暂停/继续/取消、评论覆盖统计、插件能力门槛与串行调度。155 项离线测试、typecheck、插件/web 构建及页面控制验收通过；真实小红书任务仍待部署 schema、加载 0.1.8 插件后小范围试跑。作者页、推荐页和高级条件未实现，不能标记成第三版全部完成。详见 `docs/t5-collection-verification.md`。

按 `docs/hot-collection-plan.md` 第三版做自动浏览任务（关键词/对标作者 → 筛选 → 深度采集），扩大分析样本（当前生产库只有 1 个库 27 篇）。

## 已知问题 / 小活

- `apps/server/test/api.test.ts` full loop 用例在北京时间 0–8 点会失败（overview trend 按天分桶的时区不一致），main 上既有，与发布无关
- 插件心跳间隔 5 分钟偏长，刷新插件后账号短时间显示「超时」；可考虑 2 分钟
- 一次发布 2–4 分钟，主要耗在逐个话题等联想框（每个最多 8s），可优化
- 发布页选择器/版式写死在 `creator-publish.ts`（含 closed shadow 发布按钮 +72px 偏移），小红书改版要同步改；失败时插件会带诊断回传，看 `publish_jobs.error`
- 生产库测试痕迹：`publish_jobs` #1–#12（失败）、#13（成功，仅自己可见）、草稿 #7（图片 URL 指向已删除的本地测试图）；是否清理由用户决定，**别自行删除**

## 约定提醒

- 改契约先改 `packages/shared`；平台差异只放适配目录；慢操作进 jobs；secrets 不进代码
- 验证：`npm run typecheck` · `npm test` · `npm run build:ext`
- 插件改动后用户需在 `chrome://extensions` 手动刷新（构建会同步到 `EXT_INSTALL_DIR`）；真实发布测试一律 `visibility=private`，可见性未确认绝不点发布
- 合并到 main 会自动部署到 https://xhs.v2api.top
