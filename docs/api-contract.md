# API 契约（server ↔ web ↔ extension 唯一事实源）

Base: `http://127.0.0.1:3000`（web dev server 已代理 `/api`）。
鉴权：`Authorization: Bearer <token>`。`POST /api/auth/register|login` → `{token, user}`。
插件走同一 token：工作台「授权插件」按钮经 site-bridge `SET_AUTH` 写入插件 storage。
所有业务数据按当前登录用户隔离。

## 工作台 API

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
| GET | /api/media/:id | 服务端缓存的图片（采集时入库下载） |
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

## 插件 ↔ 工作台桥（window.postMessage）

`{source:'v2m-web',type,requestId,payload}` → `{source:'v2m-ext',requestId,ok,result,error}`。
类型：PING / SET_AUTH{apiBase,token} / SYNC_ACCOUNTS / COLLECT_URL{url} / RUN_PUBLISH_JOB{jobId}。
协议常量与载荷类型都在 `@v2media/shared/protocol`。
