# 策划层 + 归因层设计 — v2-media 小红书全链路补全

> 目标：补齐五层工作流里最薄的两环——**策划**（选题池/排期）与**归因**（发布后数据回流），让「发现→策划→创作→发布→归因」真正闭环。
> 调研依据：`docs/easel-review.md`（Easel 总体架构）、`docs/xhs-extension-research.md`（插件采集机制）、Eas­el 各 SKILL 实现、小红书创作中心接口逆向公开资料（ReaJason/xhs、jackwener/OpenCLI 等）。
> 原则不变：**确定性代码做数据读写与调度，AI 只做语言/判断；所有小红书数据走插件在用户登录态浏览器里取，不做服务端逆向签名。**

---

## 一、现状盘点

已有（骨架）：
- **发现**：插件嗅探采集 → `collected_notes` + `collections` 分组 → 内容库瀑布流
- **创作**：`drafts` + `/api/ai/rewrite|titles|tags`
- **发布**：`publish_jobs`（pending→claim→done/failed，scheduledAt 定时）+ 插件驱动 creator 发布页

缺口：
- **策划**：无选题概念、无排期视图；采集库只是素材池，不产生"写什么"的决策
- **归因**：`publish_jobs` 只有 done/failed + resultUrl；发布后无数据回流、无表现分析、无经验沉淀

---

## 二、Easel 对应层拆解（可借鉴的部分）

### 策划层结构

| 组件 | 职责 | 对我们的启发 |
|---|---|---|
| content-strategy | 定义 3-5 个**内容支柱**（账号定位的展开） | 支柱 = 画像的一部分，先有支柱才有选题 |
| content-matrix | 支柱 × 8 种格式 → 批量选题标题池 | 我们的输入更有优势：直接用采集库真实爆款做选题种子 |
| topic-evaluator | 单选题深评 | 与 matrix **共用一套七维评分口径**（见下） |
| content-calendar | 月度排期（先读日历底座 context，避免排空档/撞车） | 排期前必须看"已发节奏/断更缺口"——我们可直接读 publish_jobs 历史 |
| publish-scheduler | CSV/JSON 排期表 → due → 派发 → mark | 对应我们的 publish_jobs.scheduledAt + 插件轮询，已有 |

**选题七维评分（统一口径，可直接借用）**：流量潜力 25% / 账号匹配 20% / 竞争差异化 15% / 变现潜力 15% / 时效价值 10% / 制作成本 8% / 合规风险 7%，各 1-10 分加权得综合分：≥70 做、50-69 改方向、<50 不做。维度定义与标尺见 Easel `skills/shared/scoring-dimensions.md`（Apache 2.0）。

### 归因层结构（三层分工，值得照抄这个职责划分）

```
采集底座（确定性）          分析层（AI）               沉淀层
─────────────            ─────────────            ─────────
publish_jobs.outcome  →   四维归因                  → 画像字段回写
note_metrics 时序快照      （时间/标签/类型/增长）      （styleNotes 增补）
account_snapshots         单条复盘 / 爆款规律提炼
发布读回对账               评论洞察
```

- **发布读回对账**：发完回创作者中心作品列表核对「标题前缀 + 时间窗」，四档 outcome：`verified` / `unverified`（读回通了但索引延迟没见到）/ `login_required` / `readback_error`。原则：**没有平台侧证据绝不标成功**。
- **时序快照分层保留**：近 90 天全量 / 400 天内每日 ≤1 条 / 更老每周 ≤1 条——单机文件级方案，我们用 DB 直接存，保留策略可后置。
- **复盘写回画像**：只有"真正可复用的认知"才进画像（验证有效的选题结构、失效的打法），流水账不沉淀。

---

## 三、我们能拿到什么数据（插件侧盘点）

复用现有机制：background 轮询拉任务 → 开 `creator.xiaohongshu.com` tab → content script 驱动页面 → main-world 嗅探 `/api/galaxy/*` 响应 → POST 回 server。**与发布任务同一套骨架，只是目标页和动作不同。**

### 创作中心（creator.xiaohongshu.com）可用接口

| 接口 | 数据 | 签名要求 | 用途 |
|---|---|---|---|
| `/api/galaxy/creator/note/user/posted` | 自己已发布笔记列表（tab=0 已发 /1 定时 /2 草稿 /3 已删，分页） | 页面自身签名 | **读回对账**（核对 note_id/title/时间）+ 拿 xsec_token |
| `/api/galaxy/creator/datacenter/note/analyze/list` | 每篇笔记数据分析（view/exposure/点击率 + 互动数） | 页面自身签名 | note_metrics 批量回采 |
| `/api/galaxy/creator/home/personal_info` | 账号概览（粉丝/获赞/等级） | 仅 cookie | account_snapshots |
| `/api/galaxy/creator/data/note_detail_new`、`note_detail?note_id=` | 单篇流量拆解（自然/推广/搜索来源占比） | 仅 cookie | 单篇复盘素材 |
| `/statistics/data-analysis` 页面 | 7/30 日趋势 | 页面自身签名 | 账号趋势（可选） |

> 签名说明：`/api/galaxy/v2/*` 需 `x-s/x-t/x-s-common`；但**我们从不自己发签名请求**——要么嗅探页面自己发的响应（用户浏览创作中心时顺便采），要么在页面上下文里让站点 JS 代发（同采集机制）。v1 非签名版本（`/api/galaxy/creator/*`）部分接口仅 cookie 即可，嗅探方式对两者通吃。

### www 站（已在采）增量用途

- `/api/sns/web/v1/user_posted` + `/api/sns/web/v2/comment/page`：发出去的笔记的评论回采（需 note_id + xsec_token，posted 列表响应里自带）→ 评论洞察
- `/api/sns/web/v1/feed`：用 xsec_token 读单篇详情拿最新互动数——**无需创作中心也能做粗粒度回采**（缺点：没有曝光/观看数，只有点赞收藏评论）

**结论：归因数据完全够。** 最薄的是"必须用户开着浏览器且登录创作中心"——与发布链路同约束，可接受。

---

## 四、数据模型设计（drizzle schema 增量）

```ts
// 选题池（策划层核心）
export const topics = pgTable("topics", {
  id, userId,
  title: varchar(512),            // 选题标题/方向
  angle: text,                    // 切入角度/要点说明
  sourceType: varchar(32),        // manual | collection(采集库分析) | note(单篇标记) | ai
  collectionId: → collections,    // 来源采集库（可空）
  sourceNoteId: → collectedNotes, // 来源爆款笔记（可空）
  accountId: → hostedAccounts,    // 目标账号（可空）
  status: varchar(32),            // idea | planned | drafted | published | archived
  score: integer,                 // AI 综合分 0-100（可空）
  scoreDetail: jsonb,             // 七维明细 {traffic:8, fit:9, ...}
  plannedAt: timestamp,           // 计划发布日期（排期）
  draftId: → drafts,              // 选题落草稿后回填
  publishJobId: → publishJobs,    // 发布后回填（归因关联点！）
  createdAt, updatedAt,
});

// 已发笔记指标快照（归因时序底座）
export const noteMetrics = pgTable("note_metrics", {
  id, userId,
  publishJobId: → publishJobs,    // 关联发布任务
  noteId: varchar(128),           // 小红书 note_id（读回时确认）
  noteUrl: text,
  capturedAt: timestamp,
  views: integer, likes: integer, collects: integer,
  comments: integer, shares: integer,
  exposure: integer,              // 创作中心才有；www 侧回采为空
  extra: jsonb,                   // 流量来源拆解等
});

// 账号概览快照（趋势底座）
export const accountSnapshots = pgTable("account_snapshots", {
  id, userId,
  accountId: → hostedAccounts,
  capturedAt: timestamp,
  followers: integer, likesTotal: integer, notesCount: integer,
  extra: jsonb,
});

// publish_jobs 增补
publishJobs: + outcome varchar(32)      // verified | unverified | login_required | readback_error
           + noteId varchar(128)        // 读回确认的真实 note_id
           + verifiedAt timestamp

// hosted_accounts 增补（轻量画像）
hostedAccounts: + positioning text      // 账号定位/内容支柱
                + styleNotes text       // 风格偏好（归因可沉淀增补）
                + redlines text         // 红线/禁区
```

**关联链就是归因链**：`topic → draft → publish_job → note_metrics`，加上 `topic.scoreDetail` 对比实际表现，就能回答"AI 判高分的选题真的表现好吗"。

---

## 五、服务端 API 增量

```
# 策划
POST   /api/topics                          手建选题
GET    /api/topics?status=                  选题池列表
PATCH  /api/topics/:id                      改状态/排期/角度
DELETE /api/topics/:id
POST   /api/ai/topics                       {collectionId, accountId?, count} → 选题[]+评分
POST   /api/ai/topic-score                  {topicId} → 七维深评+结论（做/改方向/不做）
POST   /api/topics/:id/to-draft             选题 → 预填草稿（进创作层）
GET    /api/calendar?days=30                聚合视图：排期 topics + scheduled/published jobs

# 归因
GET    /api/insights/overview               账号快照 + 发布量 + 互动总量趋势
GET    /api/insights/notes                  已发笔记表现榜（noteMetrics 聚合 + job/draft/topic 关联）
GET    /api/insights/notes/:jobId           单篇时序曲线 + 流量来源拆解
POST   /api/ai/postmortem                   {publishJobId} → 单篇复盘（Hook/结构/选题/时间拆解）
POST   /api/ai/patterns                     {collectionId | 已发笔记集} → 爆款共性提炼 → 建议写入 styleNotes
GET    /api/comments?noteId=                已发笔记评论回采结果
```

## 六、插件侧增量

1. **creator 域嗅探**：`main-world` 增加 creator.xiaohongshu.com 匹配（或复用 xhs.ts 模式加 `creator-galaxy.ts`），嗅探 `/api/galaxy/*` 响应。
2. **新任务类型**（复用 publish pending/claim/result 骨架）：
   - `readback`：发完 T+10min，开 `creator.xiaohongshu.com/new/note-manager` → 嗅探 posted 列表 → 按标题前缀+时间窗匹配 → 回报 outcome + noteId
   - `metrics`：按 T+1h/T+1d/T+7d 到期任务 → 开数据分析页或 note_detail → 回报该笔记指标快照
   - `account_snapshot`：每日一次 → 开创作中心首页 → personal_info → 回报账号概览
   - `comments`：按需 → www 站 comment/page 嗅探已发笔记评论
3. **调度在 server**：`jobs` 表新增上述类型 + `dueAt`；插件照旧轮询 pending。**服务端只做调度与存储，不碰签名。**
4. **频控纪律**（借 Easel redbook 教训：小红书风控节流的是**读取**）：回采任务串行、间隔 ≥20s、单批上限；失败退避不猛重试。

## 七、前端页面

| 页面 | 内容 |
|---|---|
| **选题池**（新 `topics`） | 按状态分组的选题列表（idea/planned/drafted/published）+ AI 生成入口（选采集库→出选题+评分）+ 单条深评 + "转草稿"按钮 |
| **日历**（并入选题页 tab 或独立） | 周/月视图：planned topics + scheduled jobs + published 记录，直观看排期密度/断更 |
| **数据洞察**（新 `insights`） | 顶部账号概览卡（粉丝/获赞/环比）+ 已发笔记表现榜（views/互动/来源选题）+ 单篇时序曲线 + AI 复盘按钮 + 爆款规律面板（可一键写回 styleNotes） |
| **账号矩阵**（改） | 每个账号编辑区加 定位/风格/红线 三个画像字段 |
| **发布中心**（改） | jobs 表加 outcome 列（verified 绿 / unverified 灰 / login_required 黄） |

## 八、落地切片（建议 3 个 PR）

**切片 1 — 策划层**：`topics` 表 + CRUD + 选题池页面 + `/api/ai/topics`（采集库 Top 笔记 → AI 生成选题 + 七维评分）+ 转草稿。依赖最小，先跑通"采集→选题→草稿"的决策流。

**切片 2 — 归因底座**：`publish_jobs.outcome/noteId` + `note_metrics`/`account_snapshots` 表 + 插件 `readback`/`metrics`/`account_snapshot` 任务类型 + creator 域嗅探。**这层是纯数据管道，无 AI**，跑通后数据自然积累。

**切片 3 — 归因消费**：洞察页 + `/api/ai/postmortem` + `/api/ai/patterns` + 画像字段（styleNotes 回写 + AI 改写时注入定位/风格/红线）。

## 九、风险与边界（诚实声明）

- **数据回采依赖用户在线**：浏览器关闭时 readback/metrics 任务积压，恢复后补采（note_metrics 的 capturedAt 即真实采样时间，别假装是准点）。长时间离线的号显示"数据待回采"。
- **创作中心接口改版风险**：接口路径/字段可能变——与采集解析器同处理：解析逻辑收敛在 `packages/shared`，嗅探不到时 outcome=readback_error 如实上报。
- **readback 窗口**：定时发布/草稿 tab 的笔记也要纳入 posted 匹配（tab≠0 时轮询多 tab 页），避免把"在定时队列里"误判成失败。
- **AI 复盘标注数据置信度**：没拿到曝光数（只有互动数）时，复盘结论必须标注数据缺口，不做无数据支撑的流量归因。
- **画像注入边界**：定位/风格/红线只进 AI 改写与选题 prompt，不改写流程本身；红线同时做发布前硬校验的输入之一。

## 十、开放问题

1. 选题的"内容支柱"是先让用户手填（账号编辑里加字段），还是 AI 从采集库反推建议？倾向：**采集库反推建议 + 用户确认**，符合"采集数据反哺策划"的闭环叙事。
2. 评论回采是否要进 v1？评论洞察价值高但加一条嗅探链路；可先只存数量，评论内容切片 3 再议。
3. 日历要不要支持"手动占位"（还没选题先占个坑位）？Easel 的 calendar 底座有 idea 状态，可以直接对应 topics.status=planned。
