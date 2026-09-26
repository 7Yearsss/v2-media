# v2-media 前端设计方向

> 基准：结构抄 **Buffer 2026**（左侧栏 + 账号上下文），内容库抄 **Taplio Viral Posts**（卡片流 + 一键 Rewrite/Queue），编辑器抄 **Typefully**（编辑+预览分栏），动效质感对齐 **Linear**。

## 技术基座

React 19 + Vite + Tailwind CSS v4 + shadcn 风格基座 + beUI 动效组件（已 vendor 在 `src/components/beui/`，来自 mcp.beui.dev）。不用 antd。

## 设计语言

- 浅色为主 + 完整暗色模式（`theme-toggle` 用 View Transition）
- 低饱和中性色底 + 一个品牌强调色（小红书红可取但压暗一点，如 `#E2442F`）
- 卡片化内容流、大量留白、圆角 12-16px、克制的 spring 动效（beUI 自带）
- 中文界面，字体用系统栈

## 页面 → 组件映射

| 页面 | 结构 | 关键组件 |
|---|---|---|
| 骨架 | 左侧栏（animated-sidebar）+ 顶栏（面包屑 + ⌘K + 通知铃铛 + 头像） | animated-sidebar, command-palette, notification-stack, animated-toast-stack, theme-toggle |
| 账号矩阵 | 托管账号卡片网格：头像/昵称/在线状态点/最后心跳 | tilt-card, animated-badge |
| 内容库 | **infinite-masonry 瀑布流**笔记卡片（封面+标题+作者+互动数），顶部 morphing-search + 筛选 tabs + multi-select 标签 | infinite-masonry, morphing-search, tabs, multi-select, tilt-card |
| 笔记详情 | drawer 右侧滑出：图集/正文/评论/一键"送入草稿" | drawer, button |
| 草稿工坊 | 三栏：左=草稿队列列表，中=编辑器（标题+正文+图片排序），右=小红书卡片实时预览 + AI 助手 | prompt-input, streaming-response, agent-activity, file-upload, swipeable-list |
| 发布中心 | jobs 表格：状态徽章/重试/取消；新建发布弹窗选草稿+账号+定时 | table, animated-badge, approval-card, availability-scheduler |
| 数据洞察 | 采集量趋势、Top 笔记、互动分布 | composition-chart, bump-chart, number, heat-calendar |
| 空态/加载 | 每页都要有 | loader, not-found |

## 交互约定

- ⌘K 全局命令面板：跳页面、搜笔记、发 AI 指令
- 所有异步操作走 toast 反馈；发布动作必须确认卡（approval-card）
- 插件状态在工作台右上角常驻指示（已连接/未连接，site-bridge PING）
