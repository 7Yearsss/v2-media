# 前端视觉参考与实施记录

2026-10-02。模式为视觉参考后独立实现，主参考 Typefully 内容工作台，复杂度按既有 SaaS 界面 L3。现有业务、中文、小红书封面与 URL 保留。

## 证据与选择

- [Typefully 官网](https://typefully.com/) 的公开演示 DOM 展示 Write/Plan/Analyze、草稿行队列和中央编辑；登录浮层遮挡了大部分内容，未注册/登录/发布。独立浏览器实测 demo Write 控件高 28px、13.5px/500 字号，Drafts 25px/12.5px，Schedule/Publish 26px/13.5px/600，圆角约 6–10px；这是公开演示的尺寸，不声称私人工作台全部一致。截图在忽略目录 data/typefully-public-reference.png。
- [Typefully 写作助手](https://support.typefully.com/en/articles/14756434-writing-assistant) 与 [草稿属性](https://support.typefully.com/en/articles/8717753-tags-metadata) 支持把正文、辅助与草稿上下文放在一起；借鉴层级和位置，未验证其 AI 效果。
- [Buffer 新导航官方说明](https://support.buffer.com/en-us/articles/navigating-buffers-new-dashboard-layout-JsRJX4s6QQ) 当前明确标 Beta。公开截图用于交叉核对导航分组与状态层级；原图跳转被浏览器拦住，不采用它作像素度量基准。
- GitHub 搜索没有得到可核对许可的 Typefully 工作台源码，检索到的 CLI/MCP/agent 模板不能当作工作台源码。沿用本项目 React/Tailwind/beUI 独立实现，没有移植竞品代码、字体、商标或素材。

## 设计契约

参考中借鉴的部分：紧凑侧栏、弱分割线、连续行列表、主内容留白、正文/工具分栏、动作与状态各有位置。中文控制比 demo 放大到 32–36px；重要动作继续用小红书红。营销页的渐变、英文品牌、平台图标和广告内容不带进应用。

底色 #F7F8FA、面板 #FFFFFF、主文字 #20242C、次文字 #747B88、分割线 #E6E8ED、动作 #D94038。暗色使用 #15171C/#1C1F26、浅灰文字和克制边界。系统中文字体，正文 14–15px、页面标题 24px，导航 13px；数字保持 tabular。

```text
┌ 232px 导航 ┬ 轻量顶栏：页面 / 快捷操作 / 插件与任务状态 ┐
│ 概览       ├ 页面标题 + 说明                       ┤
│ 研究与创作 │ 内容队列 / 正文或列表 / 情境工具        │
│ 发布与复盘 │ 主内容用行与面板组织，保持真实封面比例    │
│ 管理       │ 活动 AI 任务有持久状态、停止与重试入口    │
└ 账户菜单   ┴───────────────────────────────────────┘
```

初稿自审移除了“大数字卡片四件套”和到处的卡片进入/倾斜动画，改成内容就绪与待处理队列；参考的紧凑感用于操作框架，封面阅读不压缩。现有十个 URL 只做分组，完整五工作区与关系导航仍属 R4。

Chrome 上的自动深色扩展会改变第三方页面配色。本次对比与最终浅/暗/窄屏验收使用独立内置浏览器，避免把扩展改色误认成项目 CSS。样式仅浏览器预览/构建验证，不为颜色、类名或静态布局添加单测。
