/**
 * creator.xiaohongshu.com 隔离 world（document_idle）：
 * 把 main-world creator.ts 嗅探到的 /api/galaxy/* 响应转发给 background。
 * 渲染上零侵入——纯转发，不往页面注入任何 UI。
 */

import { EVT_GALAXY, sendToBackground } from "./lib/messages";
import type { GalaxyEventDetail } from "./lib/messages";

if (location.hostname === "creator.xiaohongshu.com") {
  document.addEventListener(EVT_GALAXY, (ev) => {
    const detail = (ev as CustomEvent<GalaxyEventDetail>).detail;
    // 插件刷新后旧页面里的脚本已与插件断开：sendMessage 会同步抛 "Extension context invalidated"，.catch 接不住
    if (!detail?.path || !chrome.runtime?.id) return;
    try {
      void chrome.runtime.sendMessage({ type: "GALAXY_DATA", detail }).catch(() => {});
    } catch {
      /* 插件已更新，本页需刷新 */
    }
  });
}
