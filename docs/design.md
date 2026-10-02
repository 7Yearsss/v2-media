# v2-media 前端设计方向

> 2026-10-02 视觉主参考改为 **Typefully**：紧凑导航、连续草稿队列、正文与预览分栏。Buffer 新导航（官方 Beta 文档）用于分组参考；内容研究仍参考 Taplio 的素材动作。详细证据、尺寸、颜色与实施边界见 [`research/visual-reference-2026-10-02.md`](research/visual-reference-2026-10-02.md)。现有业务独立实现，未复用竞品代码、字体或品牌素材。

## 技术基座

React 19 + Vite + Tailwind CSS v4 + shadcn 风格基座 + beUI 组件（已 vendor 在 `src/components/{motion,agents,charts,blocks}`，来自 mcp.beui.dev）。不用 antd。

## 设计语言

内容库支持网格 / 列表切换，选择保存在浏览器本地 `v2media:library-view`，默认网格。列表使用 80px 紧凑行和单列虚拟滚动，宽屏显示封面标题、作者、点赞/收藏/评论、最近采集时间、原笔记发布时间及送入草稿；容器不足 900px 时作者与两种时间合并到标题下，仍展示三个互动数。互动与时间均可点击列头双向排序；网格及窄屏使用工具栏排序菜单。发布时间缺失显示「未采到」，不能拿采集时间代替。切换视图复用筛选、分页与详情选择；桌面打开详情后列表继续可用。

- 浅色为主 + 完整暗色模式（`theme-toggle` 用 View Transition）
- 冷灰底 `#F7F8FA`、白色面板、主文字 `#20242C`、次文字 `#747B88`、边界 `#E6E8ED`、小红书红 `#D94038`；暗色 `#15171C/#1C1F26`
- 工作流使用连续队列与克制边界，资料库保留真实封面；面板圆角 12px、操作圆角 6–8px。导航 13px、正文 14–15px、页面标题 24px。去除首页卡片进入/数字滚动/倾斜装饰，保留有用途的状态反馈
- 中文界面，字体用系统栈

## 页面 → 组件映射

| 页面 | 结构 | 关键组件 |
|---|---|---|
| 骨架 | 左侧栏（animated-sidebar）+ 顶栏（面包屑 + ⌘K + 通知铃铛 + 头像） | animated-sidebar, command-palette, notification-stack, animated-toast-stack, theme-toggle |
| 账号矩阵 | 托管账号卡片网格：头像/昵称/在线状态点/最后心跳 | tilt-card, animated-badge |
| 内容库 | **infinite-masonry 瀑布流**笔记卡片（封面+标题+作者+互动数），顶部 morphing-search + 筛选 tabs + multi-select 标签 | infinite-masonry, morphing-search, tabs, multi-select, tilt-card |
| 笔记详情 | 桌面左右并排：内容库继续可操作，详情独立滚动；窄屏在内容区显示详情 | library-note-detail, button |
| 草稿工坊 | ≥1280px 三栏：232px 草稿队列、弹性正文（max 720px）、300px 预览与 AI；1024–1279px 两栏工具下置，窄屏垂直堆叠。保留账号、人设、保存状态、封面与图序 | prompt-input, file-upload, swipeable-list |
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
