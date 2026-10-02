# API 契约（server ↔ web ↔ extension 唯一事实源）

Base: `http://127.0.0.1:3000`（web dev server 已代理 `/api`）。
鉴权：`Authorization: Bearer <token>`。`POST /api/auth/register|login` → `{token, user}`。
插件走同一 token：工作台「授权插件」按钮经 site-bridge `SET_AUTH` 写入插件 storage。
所有业务数据按当前登录用户隔离。

## 工作台 API

时间排序扩展：`sort=savedAt|publishedAt`，默认降序。savedAt 是最近一次采集/补采时间；publishedAt 是小红书详情返回的原笔记发布时间，未采到时为 null。两种方向均把缺失发布时间放在最后；时间游标使用毫秒值（数据库排序也统一毫秒精度），末尾缺失值用 null + id 继续分页。

`GET /api/notes` 排序：可选 `sort=id|likes|collects|comments`、`direction=asc|desc`；默认 id 升序，互动字段省略 direction 时默认降序。按当前用户与库/关键词/来源/标签过滤后服务端排序，再分页 30 条。同值按 id 升序稳定排序；nextCursor 是不透明字符串，带字段、方向、最后值与 id，下一页必须沿用排序；非法或排序不匹配游标返回 400。兼容默认 id 升序下旧数字游标。采集中互动数变化时分页为实时结果，不承诺冻结快照。

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | /api/auth/register · /api/auth/login | `{email,password}` → `{token,user}` |
| GET | /api/accounts | 托管账号列表 `HostedAccount[]` |
| PATCH | /api/accounts/:id | `{version,positioning?,styleNotes?,redlines?}` 保存账号人设，返回 `HostedAccount` |
| DELETE | /api/accounts/:id | 解绑 |
| GET | /api/notes?keyword=&tag=&source=&collectionId=&cursor= | 内容库列表（分页 `{items,nextCursor}`；`collectionId` 数字=该库、`none`=未分组） |
| GET | /api/collections | 采集库列表 `{items:[{id,name,noteCount,createdAt}]}` |
| POST | /api/collections | `{name}` → `Collection`（同名幂等返回已有） |
| PATCH | /api/collections/:id | `{name}` 改名 |
| DELETE | /api/collections/:id | 删库（笔记 collection_id SET NULL 回未分组） |
| POST | /api/collections/:id/analyze | 对该库互动 top40 笔记跑 AI 爆款分析 → `CollectionAnalysis`（`data.stats`=服务端算的确定性统计、`data.insight`=AI 结构化洞察/`report`=原文兜底；空库 400） |
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
| POST | /api/topics | `TopicCreateRequest` → `Topic`（带 plannedAt 则 status=planned；sourceType 按来源自动判定） |
| PATCH | /api/topics/:id | `TopicUpdateRequest`；plannedAt 设置→planned / 清空→idea；drafted、published 由系统流转，手动改 → 400 |
| DELETE | /api/topics/:id | |
| POST | /api/topics/:id/to-draft | 手写转草稿 201；`{ai:true,positioning?}` 异步成稿 202+`{draft,topic,jobId}`，后台自动出封面；已有 draftId 幂等返回 200，不覆盖 |
| POST | /api/ai/topics | `{collectionId,count?≤10,accountId?}` → `{items:Topic[]}`：库内互动 Top30 → AI 生成选题+七维明细，服务端加权出 score 后落池 |
| POST | /api/ai/topic-score | `{topicId}` → `{topic,verdict,advice}`：单条深评并回写 score/scoreDetail |
| GET | /api/media/proxy?url= | 白名单 HTTPS 媒体代理，补 Referer；未启用 R2 时仍保存源链接，代理不代表永久转存 |
| GET | /api/media/objects/(img\|vid\|avatar\|upload\|cover)/<hash> | 启用 R2 后的对象；采集转存和用户图片上传由后台异步处理 |
| POST | /api/publish/jobs | `{draftId,accountId,scheduledAt?,visibility?}` → `PublishJob` |
| GET | /api/publish/jobs | 任务列表 |
| POST | /api/publish/jobs/:id/cancel | |
| GET | /api/overview | 仪表盘计数 |

## 账号人设与创作上下文

- `HostedAccount` 增加 `positioning`、`styleNotes`、`redlines`（默认空字符串）、`personaVersion`（默认 0）。PATCH 至少一个人设字段，每项最多 1000 字符，首尾空白裁去；拒绝其他字段，空字符串表示清空。必须提交当前 version，旧版本 409、跨用户 404；有实际变更才增加版本，重复保存不增加。插件心跳不覆盖这些字段。
- `AccountPersonaSnapshot` 为 `{accountId,nickname,version,positioning,styleNotes,redlines}`。选题生成/评分、成稿、分析、发布分别保存调用时的快照，后续编辑人设不会改写历史。无账号且无人设时使用通用风格。
- `Draft` 增加可空 `accountId`（写作账号）与 `personaSnapshot`（成稿时人设）。创建/PATCH 可以指定或清空 accountId；校验归属，更换写作账号增加 textVersion，防止迟到 AI 覆盖。首次新增此列时，从同用户最近关联选题继承账号；之后明确清空不被启动迁移回填。
- `/api/ai/rewrite|titles|tags` 可接收 `draftId`、可空 `accountId`：省略账号继承草稿写作账号，明确 null 使用通用风格；即使同时提供原始 title/content，draftId 仍校验归属。每次读取当前人设，注入改写、标题、标签提示词。选题生成/评分使用选题目标账号；评分中途换账号时拒绝旧结果回写（409）。
- `POST /api/collections/:id/analyze` 可接收 `{accountId?,positioning?,withVideo?}`，定位最多 1000 字符。定位覆盖只影响本次定位，账号风格/红线仍保留。报告 `data.persona` 保存快照，注入假设与深度复核，客观视觉描述不随人设改写。
- `to-draft {ai:true,positioning?}` 冻结目标账号三字段，定位覆盖语义同分析；任务执行前后检查写作账号和文字版本。成稿重试读取当前写作账号人设；原定位覆盖仅在仍是原账号时复用。
- `POST /api/publish/jobs` 可增加 `personaVersion`，过期返回 409；创建时锁实际目标账号与草稿，并冻结 `PublishJob.personaSnapshot` 与正文图集快照。旧客户端省略版本仍兼容。发布页展示目标账号红线与成稿账号不一致提示；自然语言红线是提示词/人工自查上下文，确定性违禁词校验仍沿用已有机制。

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
| GET | /api/ext/publish/:id | 单条任务+草稿全文。pending 任意认领方可见；running 仅 `?claimer=<SW_ID>` 匹配原认领方可见 |
| POST | /api/ext/publish/:id/claim | `{claimedBy}` 认领任务（防重） |
| POST | /api/ext/publish/:id/result | `{status:'done'\|'failed',resultUrl?,error?}`；done → 服务端自动排 `readback` 任务（T+10min） |
| GET | /api/ext/tasks/pending | 到期 pending 任务 `→ {tasks:ExtTask[]}`（`jobs` 表 type=readback/metrics/account_snapshot + `dueAt`；认领 >30min 的 running 自动回收为 pending） |
| POST | /api/ext/tasks/:id/claim | `{claimedBy}` 认领任务（409=已被认领） |
| POST | /api/ext/tasks/:id/result | `{status:'done'\|'failed',outcome?,data?,error?}`。readback：`data.items`=嗅探到的已发列表 → 服务端按标题+时间窗匹配 → `publish_jobs.outcome`（verified→自动排 T+1h/24h/7d `metrics`；unverified→30min 后复读 ≤3 次）；metrics：`data.rows[]` → 落 `note_metrics` 快照；account_snapshot：`data`={followers,likesTotal,notesCount,…} → 落 `account_snapshots`。readback failed → 重排 ≤3 次后定 `readback_error` |

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
