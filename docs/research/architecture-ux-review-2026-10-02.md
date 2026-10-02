# T0–T5 架构复审与前端竞品调研

2026-10-02（北京时间）。审查代码基线 `ffd7c0e`，包含 T1–T5 关键词首版；当前报告分支 `codex/architecture-ux-review`。

## 结论与验收范围

**保留 npm workspaces、Hono、Drizzle/Postgres、React/Vite、Chrome MV3、shared 纯解析器和 R2。下一阶段先收拢任务执行、身份上下文、内容与发布证据的生命周期，再调整前端工作流。** 当前没有吞吐或组织规模证据要求换框架、拆微服务、引入通用流程引擎或数据仓库。

155 项离线测试和构建通过，说明功能切片已有基础；本轮用实际 background 源码的假 Chrome 探针和内存 PGlite 又复现了发布自锁、恢复互锁、回执重复/错关联、删除历史等缺口。最新功能分支因此尚未达到生产发布门槛。前端缓存、自动保存和人设链路的问题是静态路径确认，未把它们称为实际浏览器故障注入。

| 阶段 | 目前能证明 | 仍未证明 |
|---|---|---|
| T0 | 生产 ID #2 的发布 #13 已核对，首条真实指标入库 | 1 天/7 天任务完整跑完；所有曝光/浏览字段可得 |
| T1–T3 | 离线上传/封面/人设及隔离页面链路 | 新版真实 R2、模型、人设、私密发布联合验收 |
| T4 | 冻结证据、缺失/0、观察窗口及离线复盘逻辑 | 用公开可比样本完成统计校准；真实模型复盘质量 |
| T5 | 关键词首切片、服务端 fencing、模拟执行器、页面控制 | 完整 Chrome 调度组合、真实站点恢复/优先级；作者/推荐页 |

本轮没有连接或写入生产库，没有迁移、部署、重启生产或删除测试痕迹；只增加研究报告和忽略目录中的探针。竞品没有登录、注册、付费或执行采集/发布。

## 方法与证据级别

三路独立复审：服务端、插件、前端；主审重新运行两个离线探针、核对关键源码，并检索官方产品/帮助文档与平台技术文档。

- **复现**：内存 PGlite 或实际 background 在假 Chrome/假 fetch 中执行的结果；证明本项目逻辑，不能替代真实站点验收。
- **静态确认**：能沿源码追踪确定的路径；还需要正式故障注入回归。
- **官方说明/公共页面**：竞品所公布功能、公开试阅布局；不能证明 AI 质量、完整权限或数据库覆盖。
- **建议/需测量**：本项目的设计判断，尚未实现；不把预测性能或候选设计写成事实。

可复查片段位于忽略目录 `data/review-server.md`、`review-extension.md`、`review-frontend.md`、`review-domestic-competitors.md`。可复现探针已随本报告保存到 `docs/research/probes`；从仓库根目录运行 `node node_modules/tsx/dist/cli.mjs docs/research/probes/server-state-probe.mts` 和 `node docs/research/probes/browser-execution-probe.mjs`。它们仅内存/假 driver，无生产环境配置，浏览器结果写入忽略目录 data。浏览器探针断言当前缺陷成立，修复后应失败或改写为正式回归，不能作为修复后验收通过。

## 已有架构值得保留的部分

shared 将三端契约与站点原始字段解析集中；Deps 让 AI/R2/数据库可注入，现有离线测试能覆盖业务；慢素材/成稿/复盘已有持久 jobs；图集版本、成稿 revision、发布正文/人设/评分快照和实际采样窗口已有清晰含义。内容库的游标分页、虚拟图流、原比例阅读和跨页面快捷动作也已有价值。

T5 的 task/lease/revision 和任务锁让取消、恢复与入库具备同一检查位置。问题是旧发布/归因、分析闭包和浏览器各类执行记录还没有采用同等可靠的 interface；不应继续让每个入口各自记住这些不变量。

## 发布前应处理的确认问题

优先级是本次实施排序：P0 阻塞当前发布或关键状态正确性，P1 在真实联合验收前处理，P2 后续可靠性/维护改进。不是声称这些故障已经发生在生产。

| 编号 | 级别/证据 | 触发与影响 | 代码位置 | 最小修复验收 |
|---|---|---|---|---|
| B1 | P0 / 复现 | 发布先取得 `publish:<id>` 槽；自身 TRUSTED_CLICK 又被 busy 拒绝，debugger attach=0，真实发布/私密选择受阻 | [background.ts:759](../../apps/extension/src/background.ts#L759)，owner 入口 :304，creator-publish :564 | owner 自己的 sender tab 可点击；其他 tab 拒绝；用实际 background 组合测试 |
| B2 | P0 / 复现 | 取消发布后迟到 done 会复活，两个 done 排两个 readback；未认领 metrics 可完成，任务 note-a 可写到本用户 note-b，重复插两行 | [ext.ts:292](../../apps/server/src/modules/ext.ts#L292)，:307、:415、:517、:528 | 终态/lease/attempt 校验；相同 receipt 幂等；任务与来源绑定；状态和副作用同事务 |
| B3 | P1 / 复现 | SW 重启旧关键词页挡住高优先级任务；高优先级又阻止关键词清理，连续 dispatch 不执行。回采重领开新页，只关新页，旧页继续挡槽 | [background.ts:61](../../apps/extension/src/background.ts#L61)，:421、:532、:1274 | 启动先 reconcile 自有 tabs/lease，再排优先级；有效验证页受保护；终态零孤儿页 |
| B4 | P1 / 静态确认 | 工作台 A 登出→B 登录仍复用同一个 QueryClient，key 无 userId；旧缓存可先展示，迟到请求可回填 | [auth.tsx:34](../../apps/web/src/lib/auth.tsx#L34)，[main.tsx:14](../../apps/web/src/main.tsx#L14) | 会话切换 cancel/clear；请求与缓存按用户/epoch 隔离；延迟与401故障注入 |
| B5 | P1 / 复现 | 解绑账号/删除草稿 CASCADE 删除已发任务和复盘；指标成为无发布关联孤行，媒体引用也失去依据 | [accounts.ts:59](../../apps/server/src/modules/accounts.ts#L59)，[schema.ts:132](../../apps/server/src/db/schema.ts#L132) | 解绑执行连接与归档历史分开；解绑后原文/指标/复盘/媒体仍可读 |
| B6 | P1 / 复现 | 验证出现且 finish API 失败，localBlocks=0、tabCloses=1；服务器租约到期可再次执行 | [keyword-runner.ts:89](../../apps/extension/src/lib/keyword-runner.ts#L89) | 先持久本地安全停止，保留验证页；可靠补报；用户明确继续才能解除 |
| B7 | P1 / 静态确认 | 保存失败仅存 ref；切稿又加载服务端旧文字并显示“已保存”，切回不恢复失败补丁；关闭页面失去恢复入口 | [drafts.tsx:95](../../apps/web/src/pages/drafts.tsx#L95)，:103–157、:211 | 按用户/草稿的持久编辑 outbox；切稿恢复 dirty/error；文字 CAS；离线/两标签页回归 |
| B8 | P1 / 静态确认 | 分析建议入池不传报告目标 accountId；随后只传定位，成稿丢掉账号的风格/红线 | [analysis-report.tsx:379](../../apps/web/src/components/app/analysis-report.tsx#L379)，:399 | 来源与目标账号贯穿分析→选题→草稿，服务端校验归属；两人设全链测试 |
| B9 | P1 / 静态确认 | “按同参数重新发布”从当前已改草稿/人设重新创建，不是重试原快照；旧任务标题也会随草稿改名漂移 | [publish.tsx:288](../../apps/web/src/pages/publish.tsx#L288)，:320、:472 | 重试原快照与用当前稿新发分开；展示差异/确认；列表用冻结标题 |
| B10 | P2 / 复现 | 分析是请求内 void 闭包；超时回收 failed 后，迟到模型又写 done 且保留中断 error | [collections.ts:229](../../apps/server/src/modules/collections.ts#L229)，:249、:269 | 持久输入/run/attempt；迟到 CAS/fencing；重启恢复；坏输出明确降级或失败 |
| B11 | P2 / 复现 | 两次同用户/平台/subtype/xhsUserId 心跳生成两个账号，分裂人设与归因 | [ext.ts:150](../../apps/server/src/modules/ext.ts#L150)，[schema.ts:13](../../apps/server/src/db/schema.ts#L13) | 检测已有重复关系；身份唯一键+UPSERT；保留历史，不擅自合并删除生产行 |
| B12 | P2 / 复现 | 深采队列 A/B/C 执行 A 时取消 A，完成后 shift 丢掉 B，只开 A/C | [background.ts:1108](../../apps/extension/src/background.ts#L1108)，:1176 | active 与 pending 分离；按稳定任务 ID 移除；取消/回执交错测试 |

没有把“到点仍填过期站点定时”列为问题：creator-publish 已在计划时间到点时直接发布，Run Now 清定时。真实离线延迟、时钟差和人工打开未来任务仍待验证，前端应准确说明浏览器在线依赖。

## 模块设计：把不变量集中到能测试的 interface

### 1. 浏览器执行协调模块（Strong，首先做）

现在 BrowserLane 只记内存 owner，trackedJobs、trackedTasks、collectWaiters、deepQueue、KeywordRunner 分散管理恢复、清理、回执和身份。调用者需要知道 tab 标记、release 时序、认证来源和例外点击，interface 仍浅；删除小类只是把布尔状态搬回调用者，不能消除复杂性。

建议让协调模块拥有 execution record、owner/tab/lease/auth epoch、启动 reconcile、安全停止、priority/yield、deadline 和结果 outbox。Chrome tabs/debugger/storage 是 adapter；XHS 任务只提供领域动作及分类结果。外部 interface 传任务意图和执行上下文，调用者不自己操作全局锁。结果已产生→等待 ACK→终态与“再执行一次发布”严格分开。

收益是 locality：B1/B3/B6/B12 的修复、超时/重启/授权切换测试集中在同一个 seam。假 Chrome 与真实 Chrome 是两个需要验证的 adapter，模拟测试至少加载实际 background/消息组合，再补真实浏览器小规模验收。Chrome 官方明确 SW 可被终止且全局状态会丢失，不能依赖内存 map 长期存活。[MV3 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[storage 生命周期](https://developer.chrome.com/docs/extensions/reference/api/storage)。

### 2. 执行租约与回执模块（Strong）

把 claim/heartbeat/receipt/cancel 的身份、attempt fencing、事务幂等和重试规则下沉到共同模块，浏览器任务与 server jobs 共享可靠性原则。各领域继续有不同 phase、输出和停止条件；无需把全部状态强塞入同一枚举。

数据库负责当前执行代次和唯一收据，工作执行器不靠客户端布尔值认定授权；回采固定 user/account/note/publish 关联；状态与 downstream job/outbox 原子提交。对不可重复的平台发布，恢复先核对结果，再决定是否重试。Postgres 的锁/CAS 足以先完成这层；队列读取若改 SKIP LOCKED，只用于队列语义，不能把不一致视图当普通业务查询。[PostgreSQL SELECT](https://www.postgresql.org/docs/current/sql-select.html)。

### 3. 内容版本与发布证据模块（Strong）

明确四种对象：来源素材、创作草稿、发布尝试、已发内容事实；发布尝试不可因为活动账号解绑或可编辑草稿删除而消失。先用归档/历史读取补齐 B5，再逐步让已发事实持有正文/图集/封面、人设、策划依据与原平台身份快照。

内容链保留分析/建议/选题/草稿/发布/采样/复盘的来源 ID；重试原稿和用当前稿创建新发布有不同 interface。现有冻结快照保留，不新增一个同时代替所有领域对象的万能表。第一步先建对象关系读模型和显式动作，避免一次全库搬迁。

### 4. 身份与编辑会话模块（Strong）

工作台 user_id 是数据/认证身份；托管 accountId 是创作和发布目标；浏览器当前登录 XHS 身份是执行条件。把三者分开建模。认证切换清旧 Query/Mutation、绑定请求 epoch；托管账号切换先保存当前编辑，新动作用明确默认账号，既有草稿/发布快照不被静默改写。

编辑会话集中 dirty/saving/error、待保存字段、请求序列、文字 CAS 与离线恢复。URL 保存账号/库/筛选/选中对象，未存正文放按 userId/draftId 隔离的本地编辑 outbox。TanStack Query 支持向 fetch 传 AbortSignal，取消和身份隔离需要一起设计。[Query cancellation](https://tanstack.com/query/latest/docs/framework/react/guides/query-cancellation)。

### 5. AI run 模块（Worth exploring，先迁移最慢入口）

优先把集合分析、选题生成/评分迁为冻结输入、模型/提示版本、stage、attempt、进度、输出、错误和耗时的持久 run。上传/成稿/封面/复盘已有 queue 可复用可靠性模块；请求先 202，界面读状态。

快捷改写/标题/标签先测实际耗时，再决定流式输出或持久 run，不复制多套调度。上游 AI stream 只维护 server→网关连接，不能自动维护 browser→Hono 的同步响应。Cloudflare 当前官方默认读超时为 125 秒；项目旧 100s 注释应在部署文档中更正，实际配置仍需核实。[Error 524](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-5xx-errors/error-524/)。

### 6. 读模型、媒体与部署（先量化）

- 洞察目前全量读已发任务和快照，再内存选窗口/分页；采集任务列表每 3s 重算逐篇统计。先建 1k/10k/100k 副本基准，用 SQL 选每篇对应样本、cursor/summary、窗口聚合；不把已有虚拟化再做一遍。
- 上传容量检查会列多个 R2 前缀，GC 扫业务 JSON 找引用。对象登记、引用与容量预留值得探索；先测 list 成本、对象数、GC耗时和峰值，保留已有 grace 和发布引用保护。
- 服务启动重放全部 DDL，局部维护开关不禁止新 worker。建议版本化迁移独立命令、schema version 检查、迁移互斥/超时、明确 local-isolated / production-readonly / production-worker 模式；只读模式用数据库只读角色并禁写 interface/worker。仅 localhost 隧道地址不等于隔离。
- 生产缺关键 secret 应失败关闭；没有检查线上配置，不能声称线上现在使用了开发 secret。
- 以 request→run→attempt→lease→receipt→metric 的 correlation ID 记录耗时/失联/重试/延迟；用户可见状态不暴露 token 或原始站点凭据。

## 竞品调研：取交互原则，保持数据和执行能力诚实

本次覆盖 8 个产品。国际资料为官方帮助/产品文档；国内千瓜含未登录公共 UI 观察，新红只能取得历史官方更新。没有测模型效果、付费权限、全量数据库、真实发布或客服承诺。下表“落地”是我们的设计判断。

| 产品 | 官方可核对的设计 | 对 v2-media 的落地 | 不能直接承诺 |
|---|---|---|---|
| Buffer | 新导航围绕内容上下文和渠道；单渠道时可简化导航；Ideas 与发布草稿分开。[导航文档（注明 Beta）](https://support.buffer.com/en-us/articles/navigating-buffers-new-dashboard-layout-JsRJX4s6QQ)、[内容规划](https://buffer.com/features/social-media-content-planner) | 少量主工作区＋常驻托管账号；参考/想法先保存，准备好再指定发布上下文 | 不把公开 Beta 文档称为所有用户现状；浏览器执行与其 OAuth 执行条件不同 |
| Typefully | AI 在编辑器内使用写作样本/风格；Plan 明确区分计划与自动排程。[Writing Assistant](https://support.typefully.com/en/articles/14756434-writing-assistant)、[Scheduling](https://support.typefully.com/en/articles/9210135-scheduling-and-calendar) | 草稿是创作中心；人设/参考/封面/AI在同一内容上下文；计划状态与待执行分开 | 不因上日历就宣称一定准点发布；不盲目复制自动更新排程稿，需显式版本 |
| Taplio | 参考内容有发现、搜索、保存集合及卡片级 Remix 动作。[灵感库帮助](https://intercom.help/taplio/en/articles/8808247-finding-post-inspiration-with-taplio) | 在已有素材卡片上直接分析/借鉴成稿；显示来源、适用账号和借鉴结构；研究条件可保存 | 官方所称百万内容库和语义推荐不能由当前有限采集直接复制 |
| Later | 素材到预览/排期，草稿和已发内容在视觉预览中组织；受平台数据权限影响。[Visual Planner](https://help.later.com/hc/en-us/articles/360043244233-Preview-Your-Feed-With-Your-Visual-Instagram-Planner) | 小红书原比例封面/首图预览、模板/图序与账号风格检查；复用自己的素材 | Instagram 网格不等于小红书展示形态，不复制其平台权限或数据可得性 |
| Metricool | 日历按网络和状态筛选；Published 与 Sent（需要手动完成）分别解释。[日历帮助](https://help.metricool.com/how-to-manage-your-calendar-in-metricool-xhlbw) | 发布列表＋可选周视图；“任务完成/站点核对/指标已采”分层，缺数据可解释 | 不将“已发送回执”自动等同于平台已发布；不展示无依据最佳时间 |
| Postiz | 公开架构用持久工作流和平台执行队列组织调度、恢复、可观测性。[官方架构](https://docs.postiz.com/self-host/architecture) | 借鉴持久执行与平台能力组织方式；现阶段用现有 Postgres/jobs 补齐 interface | 不按另一产品的规模直接引入整套 Temporal/Redis/框架依赖 |
| 千瓜 | 公共工作台能看到场景引导/分组导航；笔记试阅有研究筛选、模板、列表/大图、更新时间和行级分析入口。[工作台](https://app.qian-gua.com/#/workbench/red)、[笔记试阅](https://app.qian-gua.com/#/material/note) | 资料库承载研究条件和上下文动作，发布时间/采集/实采更新时间各自解释 | 未提交搜索或 AI，不能由入口证明功能效果或数据覆盖；不复制品牌投放全套导航 |
| 新红 | 2024 历史更新把收藏集合与日更监测组合。[官方历史更新](https://xh.newrank.cn/product/article/article-detail/da419e48a14e4701) | 收藏/库成为可复用研究范围；集合数量、有限采集/更新时间透明 | 官网本次访问失败，仅作历史设计参考，不声称 2026 UI 或监测能力已实测 |

Typefully 的指标文档还明确写明分析支持范围和刷新节奏；这支持我们把数据覆盖/采样时间放在图表旁边，而不是把所有指标都画成“0”。[Analytics Page & Metrics](https://support.typefully.com/en/articles/8718148-analytics-page-metrics)。

千瓜的 2026-08-26 官方文章描述把所选参考数据与创作需求相连；它是功能宣传，未评测模型，本项目应以引用证据和账号红线的可追溯性来验收。[官方 AI 文章](https://www.qian-gua.com/information/detail/3362)。新红关于周期分析、阈值通知的 2022–2023 材料仅作为历史补充，主要结论不依赖这些旧页面的当前可用性。

## 前端信息架构建议

### 从十项入口收拢为五个工作区

| 工作区 | 包含当前能力 | 主问题与下一步 |
|---|---|---|
| 今日 | 行动清单、插件/账号状态、全局任务入口 | 哪些内容已就绪？什么被阻断、需要用户处理？ |
| 资料库 | 内容库、采集任务、分析报告、已保存研究条件 | 哪些样本值得参考？选定资料直接分析/借鉴 |
| 创作 | 选题、草稿、图片/封面、人设与 AI | 把一个方向做成可确认的完整稿；保存/版本明确 |
| 发布 | 待确认/排期/执行/失败/核对中/已核对 | 用哪一版、哪个账号发？为何没执行、怎样恢复？ |
| 复盘 | 表现、采样覆盖、单篇证据、评分对照 | 事实是什么？下一篇实验如何变成有来源的选题？ |

账号配置与插件配置放辅助区；现有 URL 深链保留，先分组和上下文收拢，不一次删除页面。参考库不必被某个创作账号独占；常驻托管账号给新动作默认值，用户可明确选“通用风格/全部资料”。

### 单条内容中心与编辑器

让来源素材→分析建议→选题→草稿版本→发布尝试→采样→复盘的关系可点击追踪。补齐“草稿直接创建预选发布”和“复盘实验转选题”，转换时保留账号与证据，不让用户在另一个空表单重新找稿。

编辑器桌面建议保留草稿队列/正文，右侧用预览、AI、封面三个页签，降低同时显示所有控制的密度。写作账号与已用人设始终可见；模板封面缩略图直接切换，图集按真实顺序预览；保存失败留在用户视线中，有本地恢复和重试，不能假显示已保存。窄屏分视图，沿用系统中文字体/品牌强调色和已有 beUI，不继续堆动效。

### 发布和任务中心的状态表达

显示三个独立事实：平台执行结果、读回核对结论、指标采样覆盖。浏览器在线、当前站点账号、工作台授权、扩展能力与安全阻断分别显示；不要只用“PING响应=可执行”。任务入口集中上传/成稿/封面/分析/发布/回采/采集/复盘，展示关联内容、账号、阶段、原因、最后 ACK、下一检查时间和需要用户动作；内部状态继续由各领域拥有。

优先列表，随后增加简洁周视图。计划日历和真实执行承诺分开，已有冻结版本要经显式编辑/确认更新。通知以失败/阻断/就绪/缺采等可行动事件为主，正常轮询不持续打扰。

### 前端工程配套

- 保留 React/TanStack Query，按研究/草稿/发布/复盘提供 query options/key factory 和动作模块；先抽编辑会话、身份上下文、内容关系与任务观察。
- App.tsx 当前静态引入全部页面；现物单 JS 961,717 bytes，属于文件大小观察，不是首屏耗时测量。先路由 lazy/Suspense/错误边界，再测传输与交互。
- 终态停止短轮询，活动态短间隔、隐藏/离线退避；有吞吐证据时再决定 SSE。server summary/cursor 比重复做 DOM 虚拟化更优先。
- URL 保存账号/库/筛选/对象；返回复盘列表不丢筛选。编辑正文按会话恢复，不能把未存内容放 URL。
- 补少量高价值前端测试：两用户缓存、离线切稿、分析→人设成稿、原稿/新稿重试、URL恢复。继续使用已有虚拟图流/表格与无外网测试，不为每个样式写快照。

## 推荐实施顺序与完成信号

| 顺序 | 切片 | 完成信号 |
|---|---|---|
| R0 | 固化真实组合回归，修 B1/B2/B3/B6；恢复 sender tab 与可靠结果 ACK | 实际 background+假 Chrome、取消/重复/错任务回执、启动恢复、验证+断网均通过；不会重复执行发布 |
| R1 | 用户缓存/编辑会话/人设传递/重试版本（B4/B7/B8/B9） | 两用户、两人设、两标签页、断网切稿与原稿重试可重复验收 |
| R2 | 发布证据保留、账号身份幂等、明确只读模式和版本迁移 | 解绑后历史可读；并发身份唯一；只读 interface/worker 不能写；脱敏副本升级/锁超时通过 |
| R3 | 分析/选题持久 AI run、共同租约与观测读模型 | 中断重启/迟到 attempt 不改新结果；来源和 prompt/model 可追溯 |
| R4 | 五工作区、常驻托管账号、内容关系与任务抽屉；route lazy/URL/自适应轮询 | 用户从样本到发稿到下一篇实验不中断上下文；活动/终态状态诚实可解释 |
| R5 | 新版真实 R2/模型/Chrome 私密发布及有限关键词试跑 | 用明确账号和测试库核对图序、封面、人设、发布/回采、恢复和优先级；保留测试痕迹 |
| R6 | 按公开数据与基准扩展采集/校准/查询规模 | 足够可比样本及性能证据后再决定作者页、高级条件、权重或基础设施变化 |

R0–R2 是生产联合验收的前置；每个切片保持独立、可回滚、可核对。当前报告提出建议，业务源码尚未修复。下一项建议从 R0 开始，首先解除发布自身点击的 owner 误判，并与恢复/回执组合测试一起做。
