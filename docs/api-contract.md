# API 契约（server ↔ web ↔ extension 唯一事实源）

Base: `http://127.0.0.1:3000`（web dev server 已代理 `/api`）。
鉴权：`Authorization: Bearer <token>`。`POST /api/auth/register|login` → `{token, user}`。
插件走同一 token：工作台「授权插件」按钮经 site-bridge `SET_AUTH` 写入插件 storage。
所有业务数据按当前登录用户隔离。

工作台会话使用原子本地记录和授权 epoch。换用户、换 token 或另一标签页授权变化会中止旧请求、清空旧 query/mutation 缓存并重新挂载应用；JSON、CSV、上传的迟到响应均拒绝，旧 401 不退出新用户。多步编辑/分析/重试动作捕获原会话，不在等待后套用新用户 token。屏蔽词、库偏好、已看笔记、分析定位按 userId 保存，旧无归属本地记录保留且不自动归给当前用户。

## 工作台 API

时间排序扩展：`sort=savedAt|publishedAt`，默认降序。savedAt 是最近一次采集/补采时间；publishedAt 是小红书详情返回的原笔记发布时间，未采到时为 null。两种方向均把缺失发布时间放在最后；时间游标使用毫秒值（数据库排序也统一毫秒精度），末尾缺失值用 null + id 继续分页。

`GET /api/notes` 排序：可选 `sort=id|likes|collects|comments`、`direction=asc|desc`；默认 id 升序，互动字段省略 direction 时默认降序。按当前用户与库/关键词/来源/标签过滤后服务端排序，再分页 30 条。同值按 id 升序稳定排序；nextCursor 是不透明字符串，带字段、方向、最后值与 id，下一页必须沿用排序；非法或排序不匹配游标返回 400。兼容默认 id 升序下旧数字游标。采集中互动数变化时分页为实时结果，不承诺冻结快照。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/register · /api/auth/login | `{email,password}` → `{token,user}` |
| GET | /api/accounts | 托管账号列表 `HostedAccount[]` |
| PATCH | /api/accounts/:id | `{version,positioning?,styleNotes?,redlines?}` 保存账号人设，返回 `HostedAccount` |
| DELETE | /api/accounts/:id | 幂等归档解绑，保留历史与身份；恢复用 POST /:id/restore |
| GET | /api/notes?keyword=&tag=&source=&collectionId=&cursor= | 内容库列表（分页 `{items,nextCursor}`；`collectionId` 数字=该库、`none`=未分组） |
| GET | /api/collections | 采集库列表 `{items:[{id,name,noteCount,createdAt}]}` |
| POST | /api/collections | `{name}` → `Collection`（同名幂等返回已有） |
| PATCH | /api/collections/:id | `{name}` 改名 |
| DELETE | /api/collections/:id | 删库（笔记 collection_id SET NULL 回未分组） |
| POST | /api/collections/:id/analyze | `{operationId?,accountId?,positioning?,withVideo?}` → 202 `CollectionAnalysis(status=running,aiRunId)`，事务排持久 AI 任务；空库 400 |
| GET | /api/collections/:id/analyses | 该库历史报告列表（不含 report 全文） |
| GET | /api/collections/:id/analyses/:aid | 报告全文 |
| GET | /api/notes/export?collectionId=&keyword=&source=&tag= | 导出筛选结果为 CSV（UTF-8 BOM，Excel 直开；筛选参数与列表同语义，`none`=未分组，缺省=全部；公式前缀自动转义） |
| GET | /api/notes/:id | 详情（含评论若有） |
| DELETE | /api/notes/:id | 删除 |
| POST | /api/drafts | `{collectedNoteId?}` 或手写 → `Draft`（从内容库深拷贝素材/正文） |
| GET | /api/drafts | 草稿列表 |
| GET/PATCH/DELETE | /api/drafts/:id | |
| POST | /api/ai/rewrite | `{draftId?\|title,content,instruction}` → `{title,content}` |
| POST | /api/ai/titles | `{title,content,count}` → `{titles[]}` |
| POST | /api/ai/tags | `{title,content,count}` → `{tags[]}` |
| GET | /api/topics?status= | 选题池列表 `{items:Topic[]}`（联查 collectionName/accountNickname/sourceNoteTitle） |
| GET | /api/topics/:id | 当前用户的具体选题与关联展示字段；非法 ID 400、不存在/跨用户 404，供深链恢复 |
| POST | /api/topics | `TopicCreateRequest` → `Topic`（带 plannedAt 则 status=planned；sourceType 按来源自动判定） |
| PATCH | /api/topics/:id | `TopicUpdateRequest`；plannedAt 设置→planned / 清空→idea；drafted、published 由系统流转，手动改 → 400 |
| DELETE | /api/topics/:id | |
| POST | /api/topics/:id/to-draft | 手写转草稿 201；`{ai:true,positioning?}` 异步成稿 202+`{draft,topic,jobId}`，后台自动出封面；已有 draftId 幂等返回 200，不覆盖 |
| POST | /api/ai/topics | `{collectionId,count?≤10,accountId?,operationId?}` → 202 `AiRun`，冻结库内互动 Top30 后异步生成、评分并入池 |
| POST | /api/ai/topic-score | `{topicId,operationId?}` → 202 `AiRun`，冻结原选题版本后异步深评，服务端加权并校验版本再回写 |
| GET | /api/ai/runs?kind=&status= | 当前用户最近 50 个 `{items:AiRun[]}`，可按 kind/status 筛选 |
| GET | /api/ai/runs/:id | 当前用户公共任务状态 `AiRun`；不返回原始输入、凭据或租约 |
| POST | /api/ai/runs/:id/retry | `{operationId:UUID}` → 202 `AiRun`，重试失败任务的原冻结输入；重试命令幂等 |
| POST | /api/ai/runs/:id/cancel | → `AiRun`，停止 queued/running；已 canceled 幂等，done/failed 返回 409 |
| GET | /api/media/proxy?url= | 白名单 HTTPS 媒体代理，补 Referer；未启用 R2 时仍保存源链接，代理不代表永久转存 |
| GET | /api/media/objects/(img\|vid\|avatar\|upload\|cover)/<hash> | 启用 R2 后的对象；采集转存和用户图片上传由后台异步处理 |
| POST | /api/publish/jobs | `{draftId,accountId,scheduledAt?,visibility?}` → `PublishJob` |
| GET | /api/publish/jobs | 任务列表 |
| POST | /api/publish/jobs/:id/cancel | |
| POST | /api/publish/jobs/:id/retry | `{operationId:UUID}` 原版本重试；同一操作重复返回同一新任务；不接受当前稿替代参数 |
| GET | /api/overview | 仪表盘计数 |
| GET | /api/workspace/tasks?filter=&accountId= | R4 集中只读任务观测；`filter=active\|attention\|all`，账号缺省=全部，详见下节 |

## 工作区与集中任务（R4）

- `WorkspaceTask` / `WorkspaceTasksResponse` 在 `packages/shared/src/workspace-tasks.ts`。聚合本用户 `ai_runs`、素材/成稿/封面/复盘/核对/指标/账号快照 jobs、发布与关键词采集；一个 SQL 快照观测，不续租、回收或回写状态。关联对象与账号各自再校验 userId，不返回 payload、冻结输入、提供方错误、凭据或租约标识。
- filter 为 active/attention/all，账号参数为正整数，本用户归档账号仍可观察历史，跨用户/不存在 404。每个来源/状态组分别保留最近 40 项，返回精确 counts、ranges.total/returned/truncated，已完成历史不能挤掉活动/异常。全部范围没有分页承诺，较早任务回原领域页查看。
- 发布 running 租约过期派生 `state=unknown/rawStatus=running`，不能据此判断未发布或自动重发。其他领域的过期状态只提示执行器恢复，不在观察请求中更改。下一时间表示排期、退避或有效期，不是准点执行承诺。
- refreshAfterMs：有 running/已到期 queued 为 5000，只有未来排期 queued 为 30000，纯终态/未知/暂停需人工处理时 null。抽屉只有打开、可见且在线时读取和轮询，失败停止自动重复；可手动重读。操作只跳到原领域页面，不增加第二套取消/重试规则。
- 全局创作默认账号按 userId 存储，只对新草稿、借鉴草稿、新选题与 AI 分析提供默认值。支持明确通用风格；归档/不可访问或查询错误保留原选择与未知状态，不能擅自替换账号。切换不会更新已有关联对象或历史人设；发布按原草稿优先预填，用户仍要核对目标。
- 深链：`/analysis?col=&report=`、`/topics?topic=&status=`、`/drafts/:id`、`/publish?job=`、`/collection-tasks?task=`、`/accounts?account=`。资料过滤含 keyword/col/source/tag/range/sort/note，洞察含 account/horizon/private/from/to/offset；详情返回保留原 URL 范围。参数不替代服务端归属检查，非法/跨用户对象显示无法访问。
- 草稿准备发布先等待原编辑会话保存并读取当前草稿；期间暂停编辑，离页/切稿/换授权的迟到结果不导航。只打开 `/publish?new=1&draft=&account=`，不创建任务。关闭后新建清除旧预填；提交仍使用 persona/text/images 版本并由确认卡发起。复盘实验通过 new/title/angle/account 等预填手工选题，确认后保存，不写伪造 analysisSource 或已验证评分。
- 页面按 route lazy 拆包，稳定 loader 的 lazy 类型在模块缓存，避免 Suspense 导航反复挂起。正常切稿复用编辑器；只有明确重试才替换类型。失败提供重新加载/刷新应用，不自动刷新。浏览器 ESM 缓存可能继续保留失败，明确刷新能恢复；编辑会话仍按 R1 留存。

## 持久 AI 分析、选题与深评（R3）

- 共享类型在 `packages/shared/src/ai-runs.ts`。`AiRun` 为 `{id,kind,targetType,targetId,model,promptVersion,status,stage,progress,attempt,maxAttempts,result,errorCode,errorMessage,nextAttemptAt,createdAt,updatedAt,finishedAt}`；kind 为 analysis/topic_generate/topic_score，status 为 queued/running/done/failed/canceled。progress 为 `{steps:string[],at:ISO时间}` 或 null，时间字段为 ISO/null。公共状态不含 userId、operationId、原始样本/提示词、提供方凭据、leaseId/leaseUntil。跨用户或不存在 404，非法 ID/筛选/载荷 400。
- 分析创建在一个事务中保存确定性 `data.stats`/signals 与 running 报告、冻结输入、AI run，再通过 `CollectionAnalysis.aiRunId` 关联。POST 首次返回 202 `CollectionAnalysis`；同操作重放时 running 仍 202，done/failed 返回 200 原报告。历史详情仍使用 `/collections/:id/analyses/:aid`。选题生成/评分 POST 返回 202 公共 `AiRun`，不等待模型，不返回旧同步 `{items}` / `{topic,verdict,advice}`；生成数量默认 5、范围 1–10。
- 三个创建接口可带 UUID operationId；省略兼容服务端生成新操作，客户端应保留 ID 直到确认响应。同 userId/operationId、同 kind 与规范化请求幂等返回原任务；重复不读取新样本或改成新人设，同 ID 改请求/类型 409。分析原库或原报告已删除时返回 404/409，不创建替代报告。失败后重试原任务用 retry，新资料或新选题方向使用新的创建操作。
- 排队时保存完整输入快照及哈希：分析候选池/样本/代码信号/人设/定位/视频开关、分析与视觉模型和四类系统提示词；选题生成保存 Top30 笔记 ID、标题、实采互动、标签/正文节选、库名与人设；深评保存选题材料字段及原数据库更新时间。后续 worker/恢复/原任务重试复用该输入。账号仍需属于本用户且活跃；归档增加内部执行代次，立即恢复也不能授权旧结果。选题生成/评分还检查人设版本及原来源存在/归属，来源移库、原选题改变或归档均使旧 run 停止，不能写到新内容上。
- `src/lib/ai-runs.ts` worker 每 2s 尝试认领，数据库锁与 SKIP LOCKED 支持独立进程；单 worker 串行。租约 120s，每 20s 续租，单 attempt 上限 12min，attempt 单调递增。进程中断/租约过期由 worker 回收，初始最多 3 次，按 30s/60s 退避；临时模型失败/超时同样有界恢复。无效结构输出立即 failed，不自动补齐七维或制造默认 50 分。新 run GET 只读取，不能靠页面轮询续租或触发恢复。
- 进度与领域提交检查 user/run/attempt/租约。成功输出的报告写入、选题批量插入或深评 CAS 与 run done 在同一事务；失败回滚全部领域结果。模型迟到、旧 attempt、已取消或失效目标不能覆盖新结果。生成必须返回完整七维 traffic/fit/diff/monetization/evergreen/cost/risk，各有限数值 1–10；服务端按既有权重计算综合分。整批任一选题非法则全部失败，不部分入池。公共 result 分别为 `{analysisId,collectionId}`、`{collectionId,topicIds,count}`、`{topicId,score,verdict,advice}`；原正文与七维细项继续从报告/选题接口读取。
- retry 必传 UUID operationId，仅 failed 可重新排队；已 queued 的确认兼容返回原任务。重试仍是同一 run，attempt 不清零，本次最多再尝试 3 次；目标已失效 409，原冻结输入不被当前内容替换。`ai_run_commands` 在同一事务保存成功重试命令；同 user/命令 ID 补报返回**当前** run 状态，即使已经 done/failed 也不再次排队，同 ID 换目标 409。客户端 lost ACK 时保留本次 attempt 的命令 ID；观察到另一 attempt 失败后，新的明确重试用新 ID。
- cancel 仅停止 queued/running 并撤销租约；同任务再次 cancel 幂等，done/failed 不可取消，canceled 不可 retry。分析领域报告显示 failed/“本次分析已停止”，确切 canceled/target_obsolete 原因从 run 读取。停止不承诺撤回已发给模型服务的请求；返回后不再接受其领域结果。错误使用 ai_failed/ai_timeout/invalid_output/worker_interrupted/target_obsolete/canceled 等固定分类与安全文案，不透传提供方原始错误或秘密。
- 工作台刷新后重新读服务器任务；只对 queued/running 轮询，终态停止。恢复同库运行/失败报告、历史切换与重试保持报告请求代次，旧请求不能覆盖后来选择；换授权仍遵守 R1 epoch，只读连接禁用创建/重试/停止和报告入池/成稿按钮。
- schema 版本 3 `durable-ai-runs` 追加 ai_runs、ai_run_commands、分析指针和账号内部执行代次，不改已应用的 1/2 版本或 checksum。旧 done/failed 报告原样保留；旧无 aiRunId 的 running 报告没有冻结任务，沿用超过 12min 的失败兼容处理（只读连接仅派生展示，不写库），不会自动转成新任务。生产先显式迁移并检查，再启动 worker；生产只读模式不启动 AI worker。成稿/封面/复盘等原 jobs 接口继续沿用各自契约，rewrite/titles/tags 仍保持原请求响应。

## 历史归档与运行模式（R2）

- `HostedAccount`/`Draft.archivedAt` 为 null 或 ISO 时间。账号/草稿列表默认只读活跃项，`?includeArchived=1` 含归档历史；草稿单条 GET 仍可读取归档内容。DELETE 按当前用户软归档，缺失/跨用户 404，重复不再增加版本；`POST /api/accounts/:id/restore` / `/api/drafts/:id/restore` 同 ID 恢复并返回对象，不重新执行已取消的任务。
- 账号归档保留人设、原身份、发布、账号趋势、指标和复盘；取消 pending 发布/账号快照，并撤销该账号未完成成稿的代次。草稿归档保留原文/图集/ready 素材，增加文字/图片/生成/封面代次，取消未完成上传/成稿/封面与 pending 发布。归档后立即恢复也不接受旧 AI/素材处理结果。
- 归档目标的新编辑、AI、发布、原稿重试、认领及下一次真实发布点击续租拒绝 409；已经运行的发布仍保留 running/未知现场，不能保证撤销已发送站点动作。已运行结果收据和历史 readback/metrics 继续入库，新账号快照不再认领。库和用户归属验证维持原规则。
- 六条发布证据外键为 RESTRICT（发布→草稿/账号，账号快照→账号，素材→草稿，复盘/指标→发布），防止未来物理删除再次静默丢失历史。GC 继续保护归档草稿与发布快照引用的对象。
- 心跳按 `(userId,platform,subType,xhsUserId)` 唯一身份原子 UPSERT，仅更新观测资料/状态，不改人设或 archivedAt。ID 必须非空、trim 后无空白/控制字符、≤128；非法/批内重复 400。不同用户与 pc/creator 仍分开。身份和每日账号快照排期同事务；并发心跳不创建重复账号/快照。旧重复/非规范身份阻塞迁移，`db:duplicates` 只报告，不合并删除。
- `GET /api/runtime`（公共元数据）及 `/health` 返回 `{ok,runtimeMode,schemaVersion}`。默认 `local-isolated` 只用隔离 PGlite，拒绝 PostgreSQL URL；如配置真实 R2，必须 `LOCAL_R2_BUCKET=R2_BUCKET` 声明独立桶且不可为生产 `v2-media`。依赖注入的离线 mock 不受此配置入口限制。
- `production-readonly` 要求专用 PG 角色、read-only 连接、有效 AUTH_SECRET；拒绝所有 API 写方法（403 `runtime_readonly`），仅允许无入库的登录，以及 GET/HEAD/OPTIONS。读取陈旧账号/分析、候选回采任务不回写状态。worker/上传/成稿/复盘/媒体维护的低层入口也停止，数据库有效角色权限独立限制写入；工作台提示只读状态。
- `production-worker` 要求显式 PG URL、至少 32 字符 AUTH_SECRET、64 hex 字符 ENCRYPTION_KEY。生产两模式启动只读检查迁移账本/校验和、列和关键约束，不自动重放 DDL；版本不符拒绝启动。显式迁移事务包含业务升级和账本，迁移锁默认等待 10s，语句上限 120s，任何失败整体回滚。历史结构升级与首次写作账号回填只运行一次；已应用迁移不能改写。

## 账号人设与创作上下文

- `HostedAccount` 增加 `positioning`、`styleNotes`、`redlines`（默认空字符串）、`personaVersion`（默认 0）。PATCH 至少一个人设字段，每项最多 1000 字符，首尾空白裁去；拒绝其他字段，空字符串表示清空。必须提交当前 version，旧版本 409、跨用户 404；有实际变更才增加版本，重复保存不增加。插件心跳不覆盖这些字段。
- `AccountPersonaSnapshot` 为 `{accountId,nickname,version,positioning,styleNotes,redlines}`。选题生成/评分、成稿、分析、发布分别保存调用时的快照，后续编辑人设不会改写历史。无账号且无人设时使用通用风格。
- `Draft` 增加可空 `accountId`（写作账号）与 `personaSnapshot`（成稿时人设）。创建/PATCH 可以指定或清空 accountId；校验归属，更换写作账号增加 textVersion，防止迟到 AI 覆盖。首次新增此列时，从同用户最近关联选题继承账号；之后明确清空不被启动迁移回填。
- PATCH title/content/tags/accountId 必须带非负整数 `textVersion`；缺版本 428、旧版本 409，锁草稿后比较再写。图片继续用独立 imagesVersion；文字与图片在同一请求时两个版本都校验。就绪状态等仅元数据可省略文字版本。客户端按 userId/draftId/编辑窗口持久保存待写 patch 与基础版本；切稿、刷新、断网保留 dirty/error，409 明确保留本地并展示服务器版本，只有用户选择才按最新版本重存或采用服务器文字。迟到 ACK 不丢掉等待期间的新编辑。
- `/api/ai/rewrite|titles|tags` 可接收 `draftId`、可空 `accountId`：省略账号继承草稿写作账号，明确 null 使用通用风格；即使同时提供原始 title/content，draftId 仍校验归属。每次读取当前人设，注入改写、标题、标签提示词。选题生成/评分使用选题目标账号；评分中途换账号时旧 run 置 canceled/target_obsolete，不回写评分，重新评分须创建新操作。
- `POST /api/collections/:id/analyze` 可接收 `{operationId?,accountId?,positioning?,withVideo?}`，定位最多 1000 字符。定位覆盖只影响本次定位，账号风格/红线仍保留。报告 `data.persona` 保存快照，注入假设与深度复核，客观视觉描述不随人设改写。
- `to-draft {ai:true,positioning?}` 冻结目标账号三字段，定位覆盖语义同分析；任务执行前后检查写作账号和文字版本。成稿重试读取当前写作账号人设；原定位覆盖仅在仍是原账号时复用。
- 分析建议入池可提交 `analysisId` + `analysisIdeaIndex`（同时给出）。服务端从本用户 done 报告核验库/建议/引用和报告目标账号，缺省继承目标、显式错目标 409，生成不可伪造的 `Topic.analysisSource`（报告/库/索引/本次定位/报告人设）；不接收客户端历史快照。成稿使用具体来源报告的证据与当前目标三字段，仍是原账号时沿用本次定位；明确换目标不沿用旧定位。来源报告删除、引用删除/移库、目标解绑不能静默降级为通用稿，须重新选择有效来源/目标。旧报告人设与来源快照不改写。
- `POST /api/publish/jobs` 可增加 `personaVersion`，过期返回 409；创建时锁实际目标账号与草稿，并冻结 `PublishJob.personaSnapshot` 与正文图集快照。旧客户端省略版本仍兼容。发布页展示目标账号红线与成稿账号不一致提示；自然语言红线是提示词/人工自查上下文，确定性违禁词校验仍沿用已有机制。
- 新建发布还可提交 `draftTextVersion` / `draftImagesVersion`；工作台提交确认时展示的两个版本，锁草稿后比较，任一变化 409，刷新后重新核对。省略仅保留旧客户端兼容。新增任务冻结 `accountSnapshot={accountId,xhsUserId,nickname}`；列表标题/账号优先来自冻结快照，历史缺字段才明确回退当前关联数据。
- 原版本重试复制 draft/persona/account/cover/planning 五种快照与原 visibility，清原排期立即入队，记录 retryOfJobId/retryOperationId。只允许执行前取消（attempt=0、未认领）或有 R0 收据证明的明确失败；done/running/过期未知、有发布证据、缺完整历史快照或原账号身份已变化均 409。同 user/operationId 唯一并事务锁定；同目标重复操作返回原新任务，跨目标复用 409；另一 operationId 不可重复克隆已有 pending/running/done 子任务的来源。确认页展示原稿/图序/人设/可见性/排期差异，另有“用当前稿新建”，后者走普通新建与当前版本核对。

## 数据洞察与单篇复盘

- `GET /api/insights/overview|notes`：Bearer + 当前用户隔离。筛选 `accountId?`、`from?/to?`（unix ms，笔记按发布任务创建日期，账号趋势按实际采样日期）、`horizon=latest|1h|24h|7d`、`includePrivate=1?`。无账号归属 404，非法日期/范围/窗口 400。默认只显示 status=done 的公开任务；非公开笔记可显式包含，永远不纳入评分对照。
- `/overview` 返回 `InsightsOverview`：笔记数、窗口内有样本数、排除非公开/重复数、六项指标合计及各自覆盖篇数、账号粉丝/获赞/发文时序、评分分组对照。指标每篇只选一个快照，不叠加累计快照；没有有效值的合计为 null。四项互动齐全才计算 interactions。账号未采到字段保持 null；不按日期插值，也不把缺失补成 0。
- `/notes` 返回 `{items:InsightNote[],total,nextOffset}`，每页 30 条，`offset?` 非负整数。先按账号分组，再按完整互动降序（缺失放最后），同值任务 ID 降序。相同账号/已核对 noteId 的重复任务保留最早任务作为规范记录，不混合不同发布任务的策划依据。仅接受本用户、与该任务已确认 noteId 匹配的指标。
- `latest` 取 capturedAt 最新快照（同时间 ID 最大）。观察窗口按 **平台实际发布时间** 计算：1h=[1h,2h)、24h=[24h,48h)、7d=[168h,192h)，取窗口内最早快照（同时间 ID 最小）。窗口不是准点快照；发布时间缺失或窗口内未采到均返回 metric=null，不能用 verifiedAt/任务创建时间替代。
- `InsightMetric` 六字段为 number|null，另有 capturedAt、ageMs（实际发布时间缺失则 null）、scheduledFor/delayMs（旧指标缺排期则 null）、source（历史缺失 unknown）、interactions。详情不返回原始 extra/xsecToken。新指标回执保存接收时实采时间、原任务排期与来源；没有合法非负数值的字段为 null。
- 新 `PublishJob` 冻结 `planningSnapshot`（选题 ID、标题、分数/七维明细、评分口径、配置模型、评分时刻、评分人设/目标账号）与 `coverSnapshot`，按草稿关联捕捉，不依赖 topic 最后一次 publishJobId。AI 新评分记录方法/模型/时间；改选题标题、角度或目标账号会清空失效评分，评分期间发生上述变更拒绝旧结果（409）。历史评分方法/发布快照不做推测回填。
- 新回执 `reportedAt` 是插件发布成功回报时刻；`publishedAt` 仅取读回匹配项提供的有效平台时间，不晚于接收时刻。`verifiedAt` 仍是核对时刻，三者不混用。现有 metrics 排期仍以 verifiedAt 为基准，洞察按真实 capturedAt 展示实际笔记年龄。
- 校准对照只纳入公开、已核对、窗口内完整互动、实际发布时间与发布前评分依据俱全、评分目标账号与发布账号一致的样本。按账号、评分口径、模型、分数段（0–59/60–79/80–100）分组，展示样本数、分数/流量潜力/互动/浏览/曝光中位数、覆盖与实际年龄范围。latest 不生成校准对照。不自动更新权重/提示词；现有样本不足以作统计校准，变现/成本/合规不能从互动推断。
- `GET /api/insights/notes/:publishJobId` → `{note,evidence,reports}`：当前正文与全部实采时序、封面/人设/评分快照、确定性数据缺口，最多 20 份复盘历史。旧任务无正文快照时明确显示当前草稿；不假装还原发布原文。
- `POST /api/ai/postmortem {publishJobId,refresh?}` → `PostmortemReport`。成功发布任务才可复盘；跨用户 404，其他状态 400。事务锁任务、冻结证据并排 `jobs.type=postmortem/status=queued`，立即 202。并发/活动任务幂等；已有 done 且未 refresh 返回 200；refresh 明确按最新证据建新历史，失败可重试。
- 报告状态 queued/running/done/failed，页面通过单篇详情轮询；记录 promptVersion/model、冻结 evidence、结构化 insight、error、engine。server worker 处理，插件不能领取/回报此任务。12 分钟遗留 processing 回收为 failed，迟到模型不能覆盖失败报告。
- 无指标、非公开笔记或历史正文缺失：engine=data_only，列数据缺口和补齐步骤，不调用 AI 评价传播表现。其余 engine=ai，模型必须区分观察/可能原因/实验，引用已提供指标 ID，引用不存在或格式无效则 failed。确定性 gaps 始终展示；模型文本仍需人工判断，不承诺消除所有无依据推断。缺浏览/曝光不能宣称互动率/点击率或推荐因果，零互动不等于内容失败。

## 关键词自动浏览采集（插件 0.1.8 / xhs-keyword-v1）

- `POST /api/collection-tasks`：`CollectionTaskRules`（keyword 1–80 字符、collectionId、minLikes 默认 1000/范围 0–1000 万、scanLimit 默认 60/范围 1–300、saveLimit 默认 10/范围 1–30 且不大于扫描数、commentLimit 默认 50/范围 0–200、intervalMs 默认 5000/范围 2000–15000）。只支持关键词搜索；每用户最多 10 个 queued/running/paused/blocked 任务。规则、库 ID/名称冻结，跨用户库 404，超容量 409，返回 201 `CollectionTask`。
- `GET /api/collection-tasks` 返回最近 50 个 `{items}`；`GET /:id?offset=` 返回 `{task,items,nextOffset}`，逐篇每页 50。DTO 不暴露 nonce、执行方或笔记访问 token；按当前 user_id 隔离。
- `POST /:id/control {revision,action:pause|resume|cancel}`：旧 revision 409。暂停/取消立即清租约并增加 revision，不删除任务、笔记或采集历史。paused/blocked/failed/partial 可 resume，failed/partial 逐篇重试仍遵守原规则。已经入库的笔记按用户+noteId 幂等更新，新增计数不重复。取消不可复活，done 不可重新运行；需要新范围时新建任务。目标库被删除不自动改到其他库，恢复返回 409。
- `CollectionTask.controlRevision` / `lastControlAction` 记录最近一次用户控制的 revision 和 pause/resume/cancel，初始为 0/null。自动租约回收与认领只增加普通 revision，不改变这两个字段。插件的验证阻断只能由较新的明确 resume/cancel 解除，不能把超时回到 queued 当作用户继续。
- `POST /api/ext/collection-tasks/claim {capability:'xhs-keyword-v1',claimedBy}` 返回 `{claim:CollectionTaskClaim|null}`。能力必传，旧插件无此协议不会误领。每用户最多一个有效 running 租约；blocked 时不认领后续关键词任务。租约 120s；过期自动重新排队、增加 revision、生成新 UUID，保留阶段、滚动位置及笔记进度。
- 所有执行接口都传 `{leaseId,revision}`：`POST /:id/heartbeat` 续租/读取进度；`/discover {cards≤50,scrollSteps≤50,exhausted?}` 去重记录搜索卡片、按点赞筛选，到扫描/候选/滚动上限转详情；`/item {noteId,detail?,commentsHasMore?,error?}` 仅接受该任务的待处理笔记，详情再核验点赞与平台 URL/完整媒体；`/finish {outcome:done|yield|blocked|failed,reason?}` 结束或让位，可能返回 partial。跨用户 404，旧/暂停/取消/过期租约 409，非法站外 URL/字段 400。单请求最多 2MiB。
- 入库和逐篇记录使用同一事务，锁任务行后检查租约；控制操作共用此锁。取消提交后的迟到响应不能新增笔记。复用 `collect-ingest.ts` 的既有完整详情/评论合并规则与异步媒体 jobs，不同步下载外部素材。
- 每篇显示 pending/skipped/saved/partial/failed、原因、关联笔记、是否已有、平台评论数、实采主评/回复数、覆盖 not_requested/none/partial/complete。评论上限包含回复；仅收到一页、缺回复或未确认末页不能标完整。未采到平台评论数为 null。达上限/缺页时任务如实显示部分完成；重试不会扩大冻结上限，也不删除笔记里先前已采到的评论。
- 插件通过 `PING.capabilities` 暴露 `xhs-keyword-v1`，`WAKE_COLLECTION_TASKS` 桥立即调度。全浏览器的自动执行使用单槽，发布→到期回采→已有深度队列→关键词任务；关键词每个动作前检查高优先级并持久让位。旧运行页在 SW 恢复时保守识别，关键词孤儿页按自有 marker 清理，重新打开并重放有限滚动；服务端笔记 ID 是幂等 checkpoint。
- 任务页 `__v2m_collect_task`/租约标记（sessionStorage 跨重定向保留）关闭普通浏览自动入库和递归深度队列。XHS 适配器仅返回 shared 解析后的搜索卡片/详情/评论，UI 提示在 Shadow DOM。最多 50 次滚动、3 次连续无增量停止搜索；每篇最多 6 轮评论滚动，每轮间隔遵守任务配置，本轮 30 分钟执行上限。都不是站点全部结果/全量评论保证。
- 检测登录失效、可见验证或安全中转页时，任务 blocked 并暂停自动执行队列，尽力保留验证页供人工处理；不重试导航绕过验证。用户在工作台明确继续/取消后解除阻断。浏览器关闭时停止、上线重新认领，不能在离线期间采集。旧手动采集路径沿用既有验证处理行为。

## 草稿图片上传

上传与素材状态接口需 Bearer 鉴权；媒体 objects 的 GET 仍无鉴权，供图片标签和插件下载使用。

- `POST /api/media/upload`：multipart 单文件 `file`、`draftId`、`imagesVersion`、UUID `uploadId`。返回 202 `{asset:MediaAsset,draft:Draft}`，在草稿图集末尾预留 `{assetId,url:""}`。相同用户/草稿/uploadId/源内容幂等；改变内容或草稿返回 409。单图 10MiB，实际格式仅静态 JPEG/PNG/WebP，最多 4000 万像素；草稿最多 9 图（产品首版限制）。
- `GET /api/media/assets/:id`：仅当前用户可见的素材状态；不含源文件路径、用户 ID 或存储凭据。status 为 queued/processing/ready/failed/canceled。ready 才有正式 URL。
- `POST /api/media/assets/:id/retry`：仅重排仍被原草稿引用的 failed 素材，返回 202；自动处理失败最多 3 次，按 30s/60s 退避。移除图片将取消关联，不能通过重试复活。
- 未配置 R2 返回 503 + `code=storage_unavailable`；超限 413，不支持/损坏的图片头 415，草稿或素材跨用户返回 404。完整解码/方向校正/去元数据在后台执行，损坏像素数据会显示处理失败。
- `Draft` 增加 `imagesVersion`；详情另有当前图集关联的 `uploads:MediaAsset[]`。正式上传对象路径 `/api/media/objects/upload/<64hex>`，按当前用户与输出内容哈希生成，返回可被插件下载的 http(s) 绝对 URL。上传 WebP 会转 PNG，JPEG 保持 JPEG；最长边不超过 4096，不放大小图。
- `PATCH /api/drafts/:id` 修改 images 时建议始终传 imagesVersion；当前或提交图集含 assetId 时必传（缺失 428，旧版本 409）。assetId 需属于该用户/原草稿并仍在图集中；正式 URL 由服务端取素材记录，不能用提交 URL 伪造 ready。历史纯 URL 图集兼容省略版本。文字修改按实际字段 PATCH，不携带旧 images 快照。
- 创建发布任务拒绝空 URL/未 ready 素材。新发布任务冻结 title/content/tags/images；插件 pending/详情与 readback 标题均使用快照。历史任务无快照时继续读取草稿。GC 计入发布快照引用，容量压力不会删除引用中的对象；空间不足拒绝新上传处理。
- 接收后源文件存 `DATA_DIR/uploads`，元数据与 `media_upload` job 写库；queued/processing 由 server worker 执行，插件不会领取。R2 和数据库回写成功后删除源文件；后台任务超过 20min 回收。无引用源文件满一天清理，仍被引用的失败源文件留供重试，移除后再清理。部署须保留 DATA_DIR（默认 apps/server/data 已被 rsync 排除）。

## 自动成稿与模板封面

- `POST /api/topics/:id/to-draft {ai:true,positioning?}` 校验当前用户、R2 可用性后，在事务中锁选题、创建唯一草稿及 `draft_generate` job，立即 202；请求不等 AI 或图片渲染。AI 成稿不复制来源笔记图片。无 ai/ai=false 保持手写转稿 201；已有绑定稿始终返回 200。未配置 R2 的新 AI 成稿返回 503，不创建半成品。
- `GET /api/drafts/:id` 返回持久进度：`generationState=idle|queued|writing|done|failed`、generationError、generationWarnings、`textVersion`；封面另有 `coverSpec`、`coverRevision`、`coverState=idle|queued|processing|ready|failed`、coverError、coverAssetId。文字 done 后后台自动排 `cover_generate`，封面 ready 后写入 images[0]。
- `POST /api/drafts/:id/cover` 接收 `{revision,spec}` → 202 `{draft,jobId}`。spec 为 `{templateVersion?,templateId,headline,subtitle?,points?,comparison?,backgroundAssetId?}`，templateVersion 缺省 1，并随参数持久保存。templateId=poster/checklist/comparison/photo；headline 最多 36 字符、subtitle 48、points 2–4 项各 28、comparison 两侧各 40。photo 仅允许当前用户 ready 的 upload 素材。无输入证据的自动模板回退 poster，不编步骤或借用原作者图片。
- 封面参数非法 400、跨用户/不存在 404、旧 revision 或文字仍在生成 409、无 R2 503。新参数会替代未完成的旧任务；旧回执不可覆盖新参数。生成失败自动退避 30s/60s，三次后 failed；再次 POST cover 即重生成。保留上一张可用封面直到新图成功，成功只替换系统封面，保留用户图序。
- `POST /api/drafts/:id/generate/retry` 只重试 failed 成稿，立即 202 `{draft,jobId}`；这是重新成稿并覆盖当前文字的明确动作。失败来源快照继续复用，新任务以当前 textVersion 为基线。手工 PATCH title/content/tags 增加 textVersion；AI 结果若发现期间有编辑则保留用户文字，状态 failed，并说明原因。
- 移除系统封面会增加 coverRevision、置 coverState=idle、清 coverAssetId，同时取消未完成封面，迟到结果不能复活图片。当前草稿/封面 queued 或 processing/writing 时不能创建发布任务；重新生成 failed 但旧图仍可用时允许沿用旧图发布。
- `MediaAsset.kind=upload|cover`；封面在 `/api/media/objects/cover/<64hex>`，1080×1440 PNG。cover 素材不走上传 retry 入口，要使用 cover 接口。文字与封面 worker 各自串行，慢模型不能阻塞其他草稿的封面渲染。服务端任务继续使用 queued/processing，插件不会领取。
- 中文字体和 OFL 许可随 server assets 打包，渲染不依赖系统字体或网络下载。生成参数、文字警告与图片均持久保存，页面刷新继续轮询。

## 插件 API（同样 Bearer）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/ext/accounts/heartbeat | `AccountHeartbeat`：插件每 5min 上报已登录账号 |
| POST | /api/ext/collect | `CollectBatch` → `{saved,ids}`（按 noteId 去重 upsert；`collectionId` 三态：缺省=不动分组、`null`=回未分组、数字=归库且校验归属） |
| GET | /api/ext/publish/pending | pending job 列表（job 全字段 + `xhsUserId` + draft 全文）。`?all=1` 含未来定时；`?account=<xhsUserId>` 只回该账号任务 |
| GET | /api/ext/publish/:id | pending 返回任务和冻结稿；running 恢复须 `?claimer=<原claimedBy>&capability=browser-execution-v2` 且租约有效；终态只返回状态元数据 |
| POST | /api/ext/publish/:id/claim | `BrowserExecutionClaimRequest` → 认领行与租约，非 pending 返回 404；不重新认领过期发布 |
| POST | /api/ext/publish/:id/heartbeat | `BrowserExecutionHeartbeat` → 续租后的状态/租约；过期或不同代次 409 |
| POST | /api/ext/publish/:id/result | `BrowserExecutionReceipt` + `{status:'done'\|'failed',resultUrl?,error?}` → ACK；done 原子更新终态/草稿/选题并仅排一个 T+10min readback |
| GET | /api/ext/tasks/pending | 到期 pending 任务 `→ {tasks:ExtTask[]}`，仅 readback/metrics/account_snapshot；已过期或旧版无租约 running 回到 pending |
| GET | /api/ext/tasks/:id | pending 返回任务；running 恢复要求原 claimer、能力和有效租约；终态仅状态元数据 |
| POST | /api/ext/tasks/:id/claim | `BrowserExecutionClaimRequest` → 认领行与租约；未到期/已认领 404 |
| POST | /api/ext/tasks/:id/heartbeat | `BrowserExecutionHeartbeat` → 续租后的状态/租约；过期或不同代次 409 |
| POST | /api/ext/tasks/:id/result | `BrowserExecutionReceipt` + `{status:'done'\|'failed',outcome?,data?,error?}` → ACK；readback 匹配非空 noteId 的标题/时间窗，verified 排三次 metrics；unverified 30min 后复读，failed 10min 后复读，最多三次；metrics/snapshot 仅写任务绑定的来源 |

### 浏览器执行协议（插件 0.1.9）

共享类型见 `packages/shared/src/browser-execution.ts`。claim 必传 `{capability:'browser-execution-v2',claimedBy}`；租约返回 `{claimedBy,leaseId:UUID,attempt:正整数,leaseUntil:ISO时间}`。heartbeat 在 claim 字段上加 leaseId/attempt；result 再加稳定 UUID receiptId。缺能力 426；非法载荷 400；非本用户 404；当前状态非 running、过期或代次不符 409。认领方必须保留原租约的 claimedBy，不能因浏览器/插件重启换成新的实例 ID。

- 发布租约 10 分钟，回采租约 2 分钟；心跳仅续仍有效的同代租约。发布过期仍为 running，发布列表派生提示结果未知，不写 failed、不自动再发。回采可回收/重领，得到新的 UUID 和递增 attempt。
- 收据按 userId/receiptId 唯一，正文规范化后做哈希；相同执行、相同正文补报返回**原 ACK**，可在终态/旧代次下补领已提交 ACK，不重复业务副作用。同 ID 换正文或目标 409。收据、业务终态、指标/快照与下游排期同事务；执行失败回滚全部写入。
- metrics done 只接受与任务 publication/note/account/user 一致的一条 row，缺数据、重复 rows、其他笔记与空指标 400；缺失值保持 null，0 为已观测零。snapshot done 至少有一个合法非负整数指标，不能把空对象当成功。readback 没有笔记 ID 不可 verified；已 verified 的历史证据不被另一回采降级或重复排指标。
- 插件先持久保存 execution 的授权 epoch/API base、租约、拥有的 tab 和 payload 交付标记，再执行；结果先存 outbox 再 POST，同一次结果补报复用 receiptId/正文。ACK 才清理记录和执行页。授权改变后的旧结果留待原授权核对，不用当前用户补报。
- 启动先核对旧执行/自有页面再派新任务。已交付的发布不重新交付或再执行；发布超时、执行页丢失、最终点击调用失败/点击后结果未确认，均停在 uncertain 并保留证据，本地 uncertain 不发服务端 failed 回执。服务端 running/过期租约不能证明站点未发布，人工核对入口仍待后续切片。明确点击前失败可报 failed。
- 真实点击前核对当前授权、服务器租约与实时 XHS 登录身份；lastAccount/过期身份缓存不能授权点击。只允许当前 owner 的 tab。验证页本地先持久阻断，即使 finish 断网也保留页面、停止后续自动任务，直到匹配授权的明确用户控制解除。

升级需同时部署新增 schema/服务端协议并加载 0.1.9；旧插件不能无租约执行。旧版已 running 的发布不能静默回收，应人工核对。取消 API 仍只取消 pending，不承诺撤销已经发送的站点动作。

`PublishJob` 新增字段：`outcome`（verified/unverified/login_required/readback_error）、`noteId`、`verifiedAt`。心跳上报在线账号若 20h 内无快照 → 自动排 `account_snapshot` 任务。插件侧任务页 URL 带 `__v2m_task=<taskId>` 标记；creator 域嗅探 `/api/galaxy/*` 响应透传，www 域嗅探 feed 详情透传，解析均在 `@v2media/shared/galaxy-parse`。

`CollectBatch.details[].comments` 是站点显示的评论数；可选 `commentsData: NoteComment[]` 是已捕获的评论明细，支持 `subComments`。分批上传按 commentId 合并去重（缺 id 的旧数据按内容去重），空明细不清除已采数据。数量与明细覆盖率分别展示，未采到明细不得当作零评论。

头像（插件 0.1.6）：采集保留 `author.avatar`、`commentsData[].avatar/userId` 与回复的同名字段。笔记列表/详情返回可选 `authorAvatar`（兼容旧数据，内部存于 rawJson.authorAvatar）；评论头像保留在 commentsData。缺省头像不覆盖已采头像。

配置 R2 后，采集仅写入 server 的 `media_store` jobs，使用 queued/processing 状态，插件不会领取。后台任务校验 userId，按源地址哈希去重，头像下载并发最多 2、源文件最多 2MiB，转为不放大且最大 96×96 的 WebP（quality 75）。失败保留原链供代理展示；显示失败回退文字头像。数据库执行失败最多重试 3 次，超时 processing 会回收；远程下载失败由下次采集再次尝试。

头像存 `avatar/<hash>-sd`，返回同源 `/api/media/objects/avatar/<hash>-sd` 路径（普通图片/视频仍返回绝对 URL）。独立目录兼容本地与旧生产服务器共享 R2，避免旧 GC 把新头像视为无引用图片；新版 GC 识别作者、评论与回复引用。线上使用头像需部署新版 media 路由与 GC；本地通过 Vite API 代理读取。

## 插件 ↔ 工作台桥（window.postMessage）

`{source:'v2m-web',type,requestId,payload}` → `{source:'v2m-ext',requestId,ok,result,error}`。
类型：PING / SET_AUTH{apiBase,token} / SYNC_ACCOUNTS / COLLECT_URL{url} / RUN_PUBLISH_JOB{jobId}。
协议常量与载荷类型都在 `@v2media/shared/protocol`。

## 插件本地热度规则（0.1.4）
共享 HotFilter 类型与 passesHotFilter / normalizeHotFilter 定义于 packages/shared/src/hot-filter.ts。chrome.storage.local.v2m_settings.hotFilter = {enabled:boolean,minLikes:number}；缺省关闭，默认阈值 1000，整数且非负。规则仅限制浏览自动采集；手动采集本篇、一键全部入库与工作台 URL 采集不受限制。先筛点赞再补详情；独立详情也须过门槛，未入库的评论不能绕过筛选。未开始上传的自动批次在 flush 时按最新规则再次筛选，已入库笔记继续补详情/评论且保持原采集库。没有新增服务端接口。
