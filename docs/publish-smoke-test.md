# 插件发布冒烟测试记录

2026-10-01。目标：验证「选题 → AI 成稿 → 插件发布」这条链路能真正发出一篇笔记。此前 `publish_jobs` 从未跑通过。

## 测试条件

- 账号：「哈哈以哈哈」（xhsUserId `678e4e4f000000000e01efca`），PC 端 Chrome 已登录创作中心
- 草稿 #7：选题「山姆牛排」经 `POST /api/topics/:id/to-draft {ai:true}` 生成（约 8 秒），1 张测试文字封面
- 全部任务 `visibility=private`（仅自己可见）；本地服务连的是生产库，以下任务都在线上数据里
- 结果：第 13 次跑通，跳转 `/publish/success`，并自动排了 T+10min 的 readback 任务

## 每次失败与根因

| 任务 | 失败位置 | 报错 / 现象 | 根因 | 修复 |
|---|---|---|---|---|
| #1 | 填标题 | 找不到标题输入框 | 发布页在 (-9727,-9918) 放了一份同名「上传图文」tab，可见性判断只看宽高，点中了屏外那份，页面停在「上传视频」；图片被塞进只收视频的 input，预览检查又太宽松，误判上传成功 | `isShown` 排除负坐标屏外元素；只认图片 accept 的 file input；标题输入框改为等待出现 |
| — | 插件心跳 | 刷新插件后账号一直「心跳超时」，任务不被领 | SW 每次被唤醒都执行顶层 `chrome.alarms.create`，同名 create 会重置计时，唤醒它的那次 alarm 被替换，周期永远到不了；开着工作台时页面每 12s PING 让 SW 常驻，所以「打开工作台就好了」 | alarm 不存在才创建；`onInstalled/onStartup` 立刻心跳 + 轮询一次 |
| — | 工作台页面 | `Extension context invalidated`（site-bridge / creator-tasks） | 插件刷新后已打开页面里的旧内容脚本与插件断开，`chrome.runtime.sendMessage` 同步抛错 | 先判 `chrome.runtime?.id`，try/catch 兜住，提示刷新本页 |
| #2 | 切换图文 | 等待超时：切换到「上传图文」 | tab 是微前端异步渲染的，脚本执行时还没出现，只点一次就放弃 | 30s 内每秒检查，未切到就重点，直到图片 input 出现 |
| #3 #4 | 可见性 | 等待超时：可见性选项「仅自己可见」 | 可见性已改成 d-select 下拉，不认合成 `click()`；改成 debugger 真实点击后，坐标在 attach 前计算，attach 弹出「正在调试」提示条把页面下推，点偏 | 真实点击改为 attach 后在页面里现场量坐标 |
| #5 #6 | 可见性 | 下拉框已找到，真实点击成功，可见选项 0 个 | 怀疑后台标签页不渲染浮层（后证实不是全部原因） | 真实点击前把发布页切到前台 |
| #7 | 可见性 | 同上 | 每次真实点击都 attach/detach，detach 时提示条收起、视口变化，下拉浮层随之关闭 | 「展开下拉 + 选选项」在同一次 attach 里完成 |
| #8 | 可见性 | 展开后没等到选项 | 点击时 `scrollIntoView({block:"nearest"})` 把下拉滚到底部吸底发布栏下面 | 改为滚到视口中间；点前 `elementFromPoint` 检查遮挡；没展开就 Esc 后重点，最多 3 次 |
| #5–#8 | 排队 | 任务要等 4–5 分钟才被领 | 识别当前账号时正则把 `red_id`（小红书号 26778919425）也当 userId，拿它过滤任务一条都匹配不上，等 60s 缓存过期换路径才对 | 首页抓取只认 24 位 hex 的 userId；`__INITIAL_STATE__` 解析去掉 `red_id` 兜底（否则心跳也可能建出幽灵账号） |
| #9 | 发布按钮 | 等待超时：发布按钮 | 见 #12 | 放宽查找 + 诊断 |
| #10 | 可见性 | 第1步被 DIV.item 遮挡 | 最后一个话题的联想框没收起，盖住下拉框 | 加完话题后 Esc + 失焦，等联想框收起 |
| #11 | 可见性 | 点了 3 次下一步元素仍未出现 | 事先给「仅自己可见」选项打的定位标记落在旧节点上，下拉展开时选项重新渲染 | 选项改为展开后按文字现场查找 |
| #12 | 发布按钮 | 候选里只有大容器和侧栏「发布笔记」 | 发布按钮在 `<xhs-publish-btn>` 的 **closed shadow root** 里，脚本完全看不到内部 `<button>` | 见下 |
| #13 | — | **发布成功** | | |

## 发布按钮（closed shadow）

```html
<xhs-publish-btn is-save-draft="true" submit-text="发布" save-text="暂存离开"
                 submit-disabled="false" submit-loading="false">
  #shadow-root (closed)
    <div class="publish-page-publish-btn">   <!-- flex 居中，gap 24px -->
      <button class="ce-btn white">暂存离开</button>   <!-- 120px -->
      <button class="ce-btn bg-red">发布</button>      <!-- 120px -->
```

- 可用状态看宿主属性 `submit-disabled` / `submit-loading`
- 「发布」中心 = 宿主中心 + 72px（无暂存按钮时在中心）；点击前 `elementFromPoint` 必须命中宿主（closed shadow 内部命中会被重定向成宿主），否则视为被遮挡不点
- 用 debugger 真实点击（`TRUSTED_CLICK` 的 `selectors` 支持 `"选择器 @text=甲|乙"` 和 `" @dx=N"`）

## 经验

- **创作中心大量组件只认 isTrusted 事件**：可见性下拉、发布按钮都要走 `chrome.debugger` 的 `Input.dispatchMouseEvent`。attach 会弹提示条改变视口，坐标必须 attach 后现场量，多步交互放在同一次 attach 里。
- **出错先别停**：从可见性起把问题收集齐再统一报告（有任何问题都不点发布），一轮拿到全部问题；早期每轮只暴露一个问题，前后刷新插件十余次。
- **安全底线**：可见性没回读确认就中止，绝不以公开身份发出；发布按钮被遮挡、禁用、加载中都不点。
- 每次改插件都要在 `chrome://extensions` 手动刷新；刷新后不必再打开工作台。

## 遗留

- 生产库：`publish_jobs` #1–#12 为失败测试记录，草稿 #7 为测试草稿（图片链接指向已删除的本地测试封面），账号上有一篇仅自己可见的测试笔记
- readback（T+10min）与 metrics 回采待验证
- 一次发布约 2–4 分钟，主要耗在逐个话题等联想框（每个最多 8s）
