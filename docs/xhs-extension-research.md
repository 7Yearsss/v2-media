# 小红书插件逆向笔记（来自 Chrome 商店「小红书采集助手-Redhelper」CRX 解包）

> 采集技术验证：插件完全可行，以下全部是该在售插件实际使用的机制。

## 通信模式

- MAIN world（`world:"MAIN"`, `document_start`）脚本 hook `XMLHttpRequest.prototype.open/send`，包 `onreadystatechange`，readyState===4 时按 `responseURL` 前缀分发，把响应 JSON 通过 `window.dispatchEvent(new CustomEvent(...))` 发给隔离 world 的 content script。
- `__INITIAL_STATE__` 是 Vue3 reactive 包装：**数组字段要取 `._rawValue`**，例：`__INITIAL_STATE__.user.notes._rawValue[0]`（profile 页）、`__INITIAL_STATE__.feed.feeds._rawValue`（explore 首页推荐）。
- MAIN→isolated 用 CustomEvent；isolated→background 用 `chrome.runtime.sendMessage`。

## 关键 API（全部由页面自己签名，我们只读响应）

| URL 前缀（edith.xiaohongshu.com） | 响应字段 | 用途 |
|---|---|---|
| `/api/sns/web/v1/homefeed` | `data.items[]` | 首页推荐流（滚动加载） |
| `/api/sns/web/v1/search/notes` 和 `so.xiaohongshu.com/api/sns/web/v2/search/notes` | `data.items[]`（`model_type==='note'` 且有 `xsec_token` 的才是笔记） | 搜索结果 |
| `/api/sns/web/v1/user_posted` | `data.notes[]` | 用户主页作品 |
| `/api/sns/web/v2/note/collect/page` | `data.notes[]` | 用户收藏夹 |
| `/api/sns/web/v1/note/like/page` | `data.notes[]` | 用户点赞 |
| `/api/sns/web/v2/comment/page` | `data.comments[]` | 一级评论 |
| `/api/sns/web/v2/comment/sub/page` | `data.comments[]` | 楼中楼（query 里有父评论 id） |
| `/api/sns/web/v1/feed` (POST) | `data.items[0].note_card` | 笔记详情（要 note_id + xsec_token + xsec_source） |

## 数据字段（搜索/feed item 形状）

`item = { id/model_type, xsec_token, note_card: { type:'normal'|'video', user:{user_id,nickname,avatar}, interact_info:{liked_count,collected_count,comment_count,share_count}, title, desc, cover:{url_default/url_pre}, images_list?/video?, last_update_time/time } }`

详情页 URL：`/explore/{noteId}?xsec_token=...&xsec_source=pc_search`。

## 采集 UX 形态（照抄）

- 列表卡片右上角浮层"采集"按钮（Shadow DOM 注入，勿插站点 DOM）
- 详情页"采集本篇" + 批量采集当前列表已嗅探到的条目
- 插件 popup 显示已采数量 + 跳转工作台

## 发布侧提示

`creator.xiaohongshu.com/publish/publish` 是普通表单页：title input、contenteditable/quill 正文、file input（可用 DataTransfer 注入 File）、话题联想框、发布按钮。UI 驱动即可，签名由站点自己完成。
