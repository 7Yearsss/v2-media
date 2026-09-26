/**
 * Popup：连接状态 + 已采数量 + 「打开工作台」。
 * 授权信息由工作台「授权插件」经 site-bridge SET_AUTH 写入。
 */

import { sendToBackground } from "./lib/messages";

interface Status {
  version: string;
  authorized: boolean;
  appUrl: string | null;
  collected: number;
}

async function render() {
  const statusEl = document.getElementById("status");
  const openBtn = document.getElementById("open") as HTMLButtonElement | null;
  if (!statusEl || !openBtn) return;
  try {
    const s = await sendToBackground<Status>({ type: "GET_STATUS" });
    statusEl.textContent = s.authorized
      ? `已连接 ${s.appUrl} · 已入库 ${s.collected} 条`
      : "未授权：打开工作台 →「授权插件」";
    openBtn.onclick = () => {
      if (s.appUrl) void chrome.tabs.create({ url: s.appUrl });
      else statusEl.textContent = "未配置工作台地址";
    };
  } catch (e) {
    statusEl.textContent = `连接失败：${String((e as Error)?.message ?? e)}`;
    openBtn.disabled = true;
  }
}

void render();
