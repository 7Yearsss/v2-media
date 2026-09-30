# v2-media 前端设计方向

> 基准：结构抄 **Buffer 2026**（左侧栏 + 账号上下文），内容库抄 **Taplio Viral Posts**（卡片流 + 一键 Rewrite/Queue），编辑器抄 **Typefully**（编辑+预览分栏），动效质感对齐 **Linear**。

## 技术基座

React 19 + Vite + Tailwind CSS v4 + shadcn 风格基座 + beUI 动效组件（已 vendor 在 `src/components/beui/`，来自 mcp.beui.dev）。不用 antd。

## 设计语言

内容库支持网格 / 列表切换，选择保存在浏览器本地 `v2media:library-view`，默认网格。列表使用 80px 紧凑行和单列虚拟滚动，宽屏显示封面标题、作者、点赞/收藏/评论、最近采集时间、原笔记发布时间及送入草稿；容器不足 900px 时作者与两种时间合并到标题下，仍展示三个互动数。互动与时间均可点击列头双向排序；网格及窄屏使用工具栏排序菜单。发布时间缺失显示「未采到」，不能拿采集时间代替。切换视图复用筛选、分页与详情选择；桌面打开详情后列表继续可用。

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
| 笔记详情 | 桌面左右并排：内容库继续可操作，详情独立滚动；窄屏在内容区显示详情 | library-note-detail, button |
| 草稿工坊 | 三栏：左=草稿队列列表，中=编辑器（标题+正文+图片排序），右=小红书卡片实时预览 + AI 助手 | prompt-input, streaming-response, agent-activity, file-upload, swipeable-list |
| 发布中心 | jobs 表格：状态徽章/重试/取消；新建发布弹窗选草稿+账号+定时 | table, animated-badge, approval-card, availability-scheduler |
| 数据洞察 | 采集量趋势、Top 笔记、互动分布 | composition-chart, bump-chart, number, heat-calendar |
| 空态/加载 | 每页都要有 | loader, not-found |

## 交互约定

- ⌘K 全局命令面板：跳页面、搜笔记、发 AI 指令
- 所有异步操作走 toast 反馈；发布动作必须确认卡（approval-card）
- 插件状态在工作台右上角常驻指示（已连接/未连接，site-bridge PING）

### 内容库详情浏览

- 详情不使用全屏灰色遮罩或背景模糊，桌面左侧列表、筛选和导航保持可用；已选卡片用品牌色边框标记。
- 按站内阅读顺序展示：固定作者栏、原比例满宽图片、标题、正文、发布时间/属地、评论。图片不套固定高度容器、不裁切，竖图与横图均保留原比例；配分页点、前后切换、触屏横滑及查看大图入口。
- 详情头部关闭按钮、底部操作栏常驻，中间的图片、正文和评论独立滚动；支持 Esc 关闭并返回原操作位置。
- 底部保留平台互动数量与采集素材操作，评论入口只滚动右侧内容。评论区分别显示已采主评论、回复和平台评论数；回复支持展开/收起，超过 20 条主评论可展开。

- 图集使用横向 scroll-snap：鼠标按住拖动、触屏原生横滑、始终可见的中部左右箭头与分页点；支持方向键 / Home / End，键盘操作和减少动态效果设置下直接切换。拖动时禁用吸附，松手后归位；原比例随当前图片自然适配。
- 阅读详情采用系统中文字体，正文与评论 15px / 28px；白色阅读底、暗色 #19191F，弱化分割线，互动图标 24px，话题使用蓝色文字。保留 #E2442F 品牌色、#78716C 次级文字及 #E7E5E4 浅色分隔。
