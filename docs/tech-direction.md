# v2-media 技术方向调研报告 v2 — 基于 XHS_ALL_IN_ONE

> 目标产品：一站式小红书运营平台 —— 账号托管 / 插件采集 / AI 改写 / 一键发布
> 调研对象：https://github.com/cv-cat/XHS_ALL_IN_ONE（约 1.1 万行 Python + 逆向 JS 签名层）
> v2 新增：插件采集可行性验证、国外平台 UI/UX 对标、beUI 组件映射

## 结论（TL;DR）

**技术栈：复用 v2-store monorepo 骨架**（Hono + Drizzle + Postgres/PGlite + jobs 队列 + workspace 隔离），小红书作为第一个 channel；**前端升级为 Tailwind + shadcn 基座 + beUI 动效组件**（对标 Linear/Typefully 的视觉水准，而不是 v2-store 的 antd 工作台风）。

**采集 & 发布都走浏览器插件**——实测确认这条路完全成立（见第二节证据链），且插件代码模式 v2-store 里已经写好可以直接抄。

---

## 一、XHS_ALL_IN_ONE 拆解（v1 结论不变）

| 层 | 内容 | 我们的态度 |
|---|---|---|
| `apis/` + `xhs_utils/` | 全套逆向签名 SDK（X-s/X-S-Common/x-rap-param/websectiga/mnsv2 三档 + curl_cffi TLS 指纹 + Node 子进程跑 JSVMP） | 不引入。git log 反复"更新算法"，是持续维护负担；无 LICENSE 文件且 README 写"禁止商业化" |
| `backend/` | FastAPI + SQLAlchemy + APScheduler，20+ 表，adapters 隔离 SDK | 数据模型设计可参考（notes/note_assets/note_comments/publish_jobs） |
| `frontend/` | React 19 + antd 6 | 功能形态可参考（账号矩阵/内容库/三栏草稿工坊/发布中心/自动运营），视觉不抄 |
| AI 层 | OpenAI 兼容 chat/completions + images/generations | 直接对齐我们的 new-api 网关 |

---

## 二、插件采集可行性 —— 验证结果（打消"采不下来"的顾虑）

**结论：可行，且是同类产品的主流做法。** 三条独立证据：

### 证据 1：小红书站点自身的数据通路

- 实测 `xiaohongshu.com`：所有页面都渲染 `window.__INITIAL_STATE__` SSR 状态（未登录拿到的是空壳 `feeds: []`、`loggedIn:false` —— 小红书 Web 端本身就强依赖登录；而我们的插件运行在**用户已登录**的浏览器里，该状态下 `search.feeds` / `feed.feeds` / 详情页数据都是完整填充的，含无水印图地址与互动数据）。
- 用户翻页/搜索时，页面走自己的 `/api/sns/web/v1/search/notes` 等内部 API，由站点 JS 自己完成签名。

### 证据 2：v2-store 插件已内置同款机制

`apps/extension/src/main-world/1688.ts` 现在就干这个：`world:"MAIN"` + `document_start` 注入 → hook `window.fetch`/`XMLHttpRequest` → 嗅探站点自己的 API 响应缓存下来。把 `SNIFF_API` 换成小红书接口路径、解析器换成 `__INITIAL_STATE__`/响应 JSON，就是 XHS 采集器 —— **不需要我们写任何签名代码，是小红书替我们发签名请求**。

### 证据 3：市面上已有一堆在售插件

Chrome 商店里 Redhelper 采集助手、小草莓、小白薯、"拦截并保存小红书搜索和用户主页数据"等十几款插件，全部是插件形态做小红书采集/批量下载，验证了模式成立。

### 采集能力边界（诚实说明）

| 能采 | 依赖 |
|---|---|
| 搜索结果/发现页 feed（标题、封面、作者、点赞收藏数） | 用户登录态浏览页面，插件嗅探 |
| 笔记详情全文 + 无水印图集 + 视频 | `__INITIAL_STATE__` 或详情接口响应 |
| 评论区 | 页面滚动加载时嗅探评论接口 |
| 指定 URL 批量采集 | 插件开 tab/复用页面上下文发请求 |
| ❌ 用户浏览器离线时的定时监控 | 需要二期服务端方案（届时再评估） |

---

## 三、UI/UX 对标调研（国外大厂）

### 最对口的三个产品

**1. Taplio / Tweet Hunter（最重要对标 —— 产品形态几乎一比一）**
- 「Viral posts」库 = 我们的"采集热门帖子"：每日 For You 精选 + 4M+ 帖子搜索 + 过滤器（发布时间/内容类型/作者粉丝量/互动数）
- 帖子卡片一键 → AI 改写（"in your voice"）→ 草稿 → 定时发布队列
- 可抄的 UX：帖子卡片上直接挂"Rewrite / Queue"操作、搜索理解自然语言描述、AI 设置常驻顶栏

**2. Typefully（草稿工坊的编辑器标杆）**
- 极简 writer-first 编辑器：左侧编辑、右侧平台实时预览（渲染成目标平台的样子）、AI 辅助按钮、版本历史
- 我们的三栏草稿工坊（队列 | 编辑器 | AI 助手）可以对齐它：编辑区中间、右侧放"小红书卡片实时预览 + AI 面板"

**3. Buffer（信息架构标杆，2026 刚改版）**
- 左侧导航栏 + 渠道（账号）上下文切换：Publish / Create / Community / Analytics 分区
- "calmer"设计语言：大量留白、低饱和、减少视觉噪音 —— 工作台整体基调参考

### 设计语言补充参考

- **Linear**：动效密度、快捷键、⌘K 命令面板、暗色质感 —— 操作效率感
- **Later / Pinterest**：媒体库瀑布流（小红书内容库天然该用 masonry）
- **Vercel / Stripe Dashboard**：数据洞察页的图表与空态质量
- **Postiz**（开源 Buffer 替代品）：如果想看一个开源社媒调度产品的完整页面结构，可对照其仓库

### 一句话方向

> **结构抄 Buffer（侧边栏+账号上下文），内容库抄 Taplio 的 Viral Posts 卡片流，编辑器抄 Typefully（编辑+预览分栏），动效质感对齐 Linear —— 全部用 beUI 组件落地。**

---

## 四、beUI 组件映射（自家 registry 已有货）

`mcp.beui.dev` 上现有 ~80 个组件，对本项目直接可用的：

| 页面 | 组件 |
|---|---|
| 全局骨架 | `animated-sidebar`（嵌套导航→图标栏折叠）、`command-palette`（⌘K）、`theme-toggle`、`notification-stack`、`animated-toast-stack` |
| 内容库 | **`infinite-masonry`**（瀑布流卡片，核心组件）、`morphing-search`、`tilt-card`（笔记卡片悬停）、`swipeable-list`、`multi-select`（标签筛选） |
| 草稿工坊 | `prompt-input`、`streaming-response`、`message`/`message-scroller`/`agent-activity`（AI 助手面板全套）、`file-upload`（素材管理）、`drawer`（详情侧滑）、`bottom-sheet`（移动端） |
| 发布中心 | `table`（虚拟化任务列表）、`animated-badge`（状态）、`bouncy-accordion`（校验结果）、`approval-card`（发布前确认）、`availability-scheduler`/`heat-calendar`（定时发布排期） |
| 数据洞察 | `composition-chart`、`bump-chart`、`heat-calendar`、`number`（滚动计数）、`loader` |
| 登录/引导 | `signup-form`、`otp-input`（验证码）、`not-found`、空态 |

---

## 五、推荐架构（v2 更新版）

```
v2-media/                       npm workspaces + TypeScript 全栈（同 v2-store）
├── apps/
│   ├── extension/    Chrome MV3
│   │                 · main-world/xhs.ts   document_start MAIN world：hook fetch/XHR + 读 __INITIAL_STATE__
│   │                 · content.ts          详情页/搜索页 Shadow DOM"采集"浮层
│   │                 · creator.ts          creator.xiaohongshu.com 发布页 UI 驱动
│   │                 · site-bridge.ts      工作台 ↔ 插件双向通道（v2-store 同款）
│   ├── server/       Hono + Drizzle + PGlite/Postgres
│   │                 modules: accounts / collects(内容库) / drafts / ai / publishJobs / tasks
│   │                 jobs 队列 SKIP LOCKED；凭据 AES-256-GCM；workspace_id 隔离
│   ├── web/          React + Vite + Tailwind + shadcn 基座 + beUI 组件
│   │                 页面：发现/内容库(瀑布流) / 草稿工坊(三栏) / 账号矩阵 / 发布中心 / 洞察
│   └── packages/
│       └── shared/   类型 + 小红书数据解析器（__INITIAL_STATE__/API 响应 → Note）
```

### 落地切片（不变，前端按新方向做）

1. 骨架 + 账号绑定（插件识别已登录账号 → 工作台卡片在线状态）
2. 采集 + 内容库瀑布流
3. AI 改写 + 三栏草稿工坊（new-api 网关）
4. 插件驱动发布（creator 页 UI 自动化 → publish_jobs 回传）
5. 二期：Cookie 托管解锁离线任务、定时发布、监控、多平台

### 风险提醒（v2 补充）

- 采集完全依赖**用户登录态的浏览行为** —— "平台内搜索框+无浏览就全量拉取"做不到；产品形态应是"浏览即采集+一键入库"（浮层按钮 + 自动嗅探滚动结果），而不是服务端爬虫式全站搜索。Taplio 那种"库内搜索"要靠自己沉淀的内容库做大后才有意义。
- 发布走 UI 自动化，DOM 结构变化时需维护选择器（比签名算法稳定得多，且失败可见）。
