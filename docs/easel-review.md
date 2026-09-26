# Easel 调研对照 — ZJU-REAL/Easel

> 调研对象：https://github.com/ZJU-REAL/Easel（浙大 REAL Lab，Apache 2.0，Python 3.10+）
> 定位：开源「社媒运营搭子」—— 一个 Agent 贯穿 发现→策划→创作→发布→归因，已接 7 个平台。
> 调研目的：对照 v2-media 的小红书全链路，找出可借鉴的架构模式与需避开的坑。

## 一、Easel 整体架构

```
Easel/
├── easel/             Python CLI（chat / web / skill / doctor / ping）
├── web/app.py         FastAPI 后端（~4000 行）+ React 工作台（:7860）
├── skills/openclaw/   113 个 SKILL，按五层组织（discover/plan/create/publish/attribute）
├── skills/shared/     跨 SKILL 确定性脚本（xhs_publish.py、platform_readback.py 等）
├── profiles/<账号>/   账号画像：identity/style/audience/platforms/preferences/memory 六个 md
├── outputs/           内容项目制归档（产物 + 中间文件 + manifest）
└── openclaw/          隔离的 OpenClaw agent profile + workspace（SOUL.md / AGENTS.md）
```

Agent 运行在 OpenClaw harness 上，prompt 分四层：SOUL（人格）→ AGENTS（路由规则）→ CONTEXT（路径）→ SKILL.md（按需加载）。Web 工作台通过 `openclaw agent --message` 驱动，会话靠 session-key 持久化。

### 三个核心设计

1. **画像是贯穿各层的记忆**：五个层都读 `profiles/<账号>/`；归因层把验证有效的选题/结构/红线写回 `memory.md`，输出越来越贴账号。画像以消息内联方式注入（`我当前使用的画像是「X」`），不写全局文件，避免并发竞态。
2. **确定性脚本做危险操作，LLM 只做语言/适配**：发布、约束校验、敏感信息扫描都是确定性代码；LLM 负责改写文案、按平台本地化语气。
3. **产物项目化 + 留痕闭环**：`outputs/<主题>/` 归档一切；`manifest.py` 在跨层编排时传递「产物路径+一句结论」；发布成功自动写内容日历和 publish-log，供归因层消费。

## 二、五层工作流 ↔ v2-media 现状对照

| 层 | Easel 的实现 | v2-media 现状 | 差距 |
|---|---|---|---|
| **发现** | 全网热榜聚合 + RSS + 竞品/UGC 发现（公共 API 为主，小红书站内采集很薄） | 插件采集 → 内容库（瀑布流 + collections 分组 + 筛选） | ✅ 我们更强：插件嗅探 `__INITIAL_STATE__`/站内 API，能采无水印图集/评论 |
| **策划** | 选题矩阵/评分、内容日历、系列规划、节日事件日历 | ❌ 最薄：只有采集库分组；publish_jobs 有 `scheduledAt` 但无规划视图 | 缺选题层与日历视图 |
| **创作** | 文案/卡片/海报/音视频全套 SKILL，产物入 outputs/ | 草稿工坊三栏 + AI 改写/标题/标签 | ✅ 图文链路已够；缺卡片/海报生成 |
| **发布** | 服务端 Playwright + 持久登录态，逐平台 publisher SKILL | 插件驱动 creator.xiaohongshu.com 发布页（claim/result 链路） | ✅ 路线不同，我们对风控更友好 |
| **归因** | 读回对账 + 账号数据回采 + 评论洞察 + 写回画像 | ❌ 只有 overview 计数；无发布后数据回流、无画像 | 缺整条闭环 |

## 三、发布链路做法（重点参考）

Easel 每平台一个 publisher SKILL，底层是确定性脚本 + Playwright 持久化 profile：

```
check（环境/登录态）
  → login（扫码一次，cookie 持久化到 ~/.easel-browser-profiles/<Platform>Profile）
  → plan（dry-run 预检：标题长度/媒体路径/步骤，给用户确认）
  → 人设一致性软门禁（persona-check 评分 ≥80 pass，<80 warn 但不拦）
  → content_guard 硬门禁（确定性扫描文案里的 API Key/内部路径/域名，命中 exit 7）
  → publish --exec
  → 读回对账（platform_readback.py：回创作者中心读作品列表核对标题前缀+时间窗）
```

**读回对账四档 outcome**（绝不凭脚本跑完就声明成功）：
`verified`（作品列表对上了）/ `unverified`（读回通了但没见新作品，索引延迟）/ `login_required`（登录态失效）/ `readback_error`（读回通道本身坏了）。

跨平台发布 = `PLATFORMS` 约束注册表（各平台标题/正文/标签数/画幅限制硬编码）→ `plan` 校验越限 → LLM 逐平台本地化适配 → 委派各 publisher。小红书约束：`标题≤20字 / 正文≤1000 / 标签≤10 / 图 3:4 或 1:1 / 视频竖版`。

## 四、建议吸收的模式（不依赖其技术栈）

1. **平台约束注册表** → 放 `packages/shared`：`{platform: {title, body, tags, aspect, types}}`，加平台=加一条配置，发布前 `plan` 校验越限。
2. **发布双层门禁**：
   - 软门禁：改写后内容 vs 账号定位的一致性评分（AI 做，warn 不拦）
   - 硬门禁：确定性扫描文案泄露（API key/内部 URL/绝对路径），AI 改写场景这很实际
3. **读回对账** → publish_jobs 增加 `outcome` 字段（verified/unverified/login_required/readback_error）。插件场景比 Playwright 更好做：发布成功后直接读创作者中心页面或调页面内 API 核对。
4. **轻量画像**：先落 identity/style/redlines 三个字段在 hosted_accounts 上，支撑"改写风格一致性"；后续再加 memory。
5. **策划层**：选题池（从内容库标记"想写"）+ 简单排期日历视图，复用 publish_jobs.scheduledAt。

## 五、不建议照搬的

- **服务端 Playwright 发布**：小红书对机房 IP/无指纹环境风控严格（Easel 文档自己警告"IP存在风险"拦截、建议人工确认）。我们的插件发布跑在用户真实浏览器里，天然规避。代价是必须用户在线——接受这个约束。
- **Agent 全权编排**：OpenClaw 层层转发 + manifest 传递，链路长、脆弱点藏在 prompt 里。我们确定性 pipeline + AI 局部调用（改写/标题/标签）更稳。
- **单机本地架构**：Easel 是单用户工具，无 workspace 隔离/多租户——我们已有的架构更适合产品化。
- **113 个 SKILL 的广度**：先做透小红书一条链，再考虑横向平台/能力扩展。

## 六、许可与复用

Apache 2.0，可合法借鉴代码。最有复用价值的是 `skills/shared/scripts/xhs_publish.py` 的 `SELECTORS` 选择器表（移植自 xiaohongshu-mcp，标了每条参考源）和 `publish_dispatch.py` 的 PLATFORMS 约束表——若未来要做服务端发布兜底或对照校验，可直接参考。
