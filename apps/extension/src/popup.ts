/**
 * Popup：启停开关 + 连接状态 + 已采数量 + 「打开工作台」。
 * 授权信息由工作台「授权插件」经 site-bridge SET_AUTH 写入。
 */

import { sendToBackground } from "./lib/messages";
import { getSettings, setSettings, type ExtSettings } from "./lib/settings";

interface Status {
  version: string;
  authorized: boolean;
  appUrl: string | null;
  collected: number;
  settings?: Partial<ExtSettings>;
}

async function render() {
  const statusEl = document.getElementById("status");
  const openBtn = document.getElementById("open") as HTMLButtonElement | null;
  const enabledEl = document.getElementById("enabled") as HTMLInputElement | null;
  const autoEl = document.getElementById("autoCollect") as HTMLInputElement | null;
  if (!statusEl || !openBtn || !enabledEl || !autoEl) return;

  const settings = await getSettings();
  enabledEl.checked = settings.enabled;
  autoEl.checked = settings.autoCollect;
  autoEl.disabled = !settings.enabled;

  enabledEl.onchange = async () => {
    await setSettings({ enabled: enabledEl.checked });
    autoEl.disabled = !enabledEl.checked;
    statusEl.textContent = enabledEl.checked
      ? "插件已启用"
      : "插件已停用（采集/心跳/发布都暂停）";
  };
  autoEl.onchange = async () => {
    await setSettings({ autoCollect: autoEl.checked });
    statusEl.textContent = autoEl.checked
      ? "浏览小红书时会自动采集"
      : "已关自动采集，仍可用卡片按钮手动采";
  };

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
