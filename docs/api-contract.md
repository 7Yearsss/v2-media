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
| POST | /api/topics/:id/to-draft | 转草稿（幂等，已有 draftId 返回原草稿）→ `{draft,topic}`（topic→drafted） |
| POST | /api/ai/topics | `{collectionId,count?≤10,accountId?}` → `{items:Topic[]}`：库内互动 Top30 → AI 生成选题+七维明细，服务端加权出 score 后落池 |
| POST | /api/ai/topic-score | `{topicId}` → `{topic,verdict,advice}`：单条深评并回写 score/scoreDetail |
| GET | /api/media/proxy?url= | 白名单 HTTPS 媒体代理，补 Referer；未启用 R2 时仍保存源链接，代理不代表永久转存 |
| GET | /api/media/objects/(img\|vid)/<hash> | 启用 R2 后的转存对象，采集后由后台异步下载并回写笔记地址 |
| POST | /api/publish/jobs | `{draftId,accountId,scheduledAt?,visibility?}` → `PublishJob` |
| GET | /api/publish/jobs | 任务列表 |
| POST | /api/publish/jobs/:id/cancel | |
| GET | /api/overview | 仪表盘计数 |

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
