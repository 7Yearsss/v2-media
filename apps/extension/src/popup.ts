/**
 * Popup：启停开关 + 连接状态 + 已采数量 + 「打开工作台」。
 * 授权信息由工作台「授权插件」经 site-bridge SET_AUTH 写入。
 */

import { sendToBackground } from "./lib/messages";
import { getSettings, setSettings, type ExtSettings } from "./lib/settings";
import { normalizeHotFilter } from "@v2media/shared";

interface Status {
  version: string;
  authorized: boolean;
  appUrl: string | null;
  collected: number;
  settings?: Partial<ExtSettings>;
  lastDeepCollectFailure?: { noteId: string; error: string; at: number };
}

async function render() {
  const statusEl = document.getElementById("status");
  const openBtn = document.getElementById("open") as HTMLButtonElement | null;
  const enabledEl = document.getElementById("enabled") as HTMLInputElement | null;
  const autoEl = document.getElementById("autoCollect") as HTMLInputElement | null;
  const deepEl = document.getElementById("deepCollect") as HTMLInputElement | null;
  const colSel = document.getElementById("collection") as HTMLSelectElement | null;
  const newColRow = document.getElementById("newColRow") as HTMLElement | null;
  const newCol = document.getElementById("newCol") as HTMLInputElement | null;
  const newColBtn = document.getElementById("newColBtn") as HTMLButtonElement | null;
  if (!statusEl || !openBtn || !enabledEl || !autoEl || !deepEl || !colSel || !newColRow || !newCol || !newColBtn) return;

  const settings = await getSettings();
  const hotEnabled = document.getElementById("hotEnabled") as HTMLInputElement;
  const minLikes = document.getElementById("minLikes") as HTMLInputElement;
  const hotOptions = document.getElementById("hotOptions")!;
  const hotStatus = document.getElementById("hotStatus")!;
  const rule = normalizeHotFilter(settings.hotFilter);
  hotEnabled.checked = rule.enabled;
  minLikes.value = String(rule.minLikes);
  const updateHotControls = () => {
    hotEnabled.disabled = !enabledEl.checked || !autoEl.checked;
    hotOptions.hidden = !hotEnabled.checked;
    minLikes.disabled = hotEnabled.disabled;
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-hot-preset]")) button.disabled = hotEnabled.disabled;
  };
  const saveHotRule = async () => {
    const value = Number(minLikes.value);
    if (!minLikes.value.trim() || !Number.isSafeInteger(value) || value < 0) {
      hotStatus.textContent = "请输入大于或等于 0 的整数，设置尚未保存";
      return;
    }
    try {
      await setSettings({ hotFilter: { enabled: hotEnabled.checked, minLikes: value } });
      hotStatus.textContent = hotEnabled.checked ? `已保存：点赞 ≥ ${value} 才自动采集` : "热度筛选已关闭";
      updateHotControls();
    } catch { hotStatus.textContent = "保存失败，请重试"; }
  };
  hotEnabled.onchange = () => { updateHotControls(); void saveHotRule(); };
  minLikes.onchange = () => void saveHotRule();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-hot-preset]")) {
    button.onclick = () => { minLikes.value = button.dataset.hotPreset!; void saveHotRule(); };
  }
  enabledEl.checked = settings.enabled;
  autoEl.checked = settings.autoCollect;
  deepEl.checked = settings.deepCollect ?? false;
  autoEl.disabled = !settings.enabled;
  deepEl.disabled = !settings.enabled;
  updateHotControls();

  enabledEl.onchange = async () => {
    await setSettings({ enabled: enabledEl.checked });
    autoEl.disabled = !enabledEl.checked;
    deepEl.disabled = !enabledEl.checked;
    updateHotControls();
    statusEl.textContent = enabledEl.checked
      ? "插件已启用"
      : "插件已停用（采集/心跳/发布都暂停）";
  };
  deepEl.onchange = async () => {
    await setSettings({ deepCollect: deepEl.checked });
    statusEl.textContent = deepEl.checked
      ? "深度采集已开：自动/批量采集也会补评论"
      : "深度采集已关（手动点采集仍会补评论）";
  };
  autoEl.onchange = async () => {
    await setSettings({ autoCollect: autoEl.checked });
    updateHotControls();
    statusEl.textContent = autoEl.checked
      ? "浏览小红书时会自动采集"
      : "已关自动采集，仍可用卡片按钮手动采";
  };

  // ---------- 当前采集库 ----------
  const NEW_OPT = "__new__";
  async function renderCollections() {
    const s = await getSettings();
    const res = await sendToBackground<{ items?: { id: number; name: string }[] }>({
      type: "LIST_COLLECTIONS",
    }).catch(() => null);
    const items = res?.items ?? [];
    colSel!.innerHTML = "";
    const add = (v: string, label: string) => {
      const o = document.createElement("option");
      o.value = v;
      o.textContent = label;
      colSel!.append(o);
    };
    add("", "不分组");
    // 列表拉取失败时保住已选库：临时加一个占位项，等下次打开再核对
    if (res === null && s.collectionId != null) {
      add(String(s.collectionId), `已选库 #${s.collectionId}`);
    }
    for (const c of items) add(String(c.id), c.name);
    add(NEW_OPT, "＋ 新建库…");
    // 列表拉到了才核对：已选的库被删了就回退到不分组；没拉到（res=null）不清
    const cur =
      res !== null && s.collectionId != null && !items.some((c) => c.id === s.collectionId)
        ? ""
        : String(s.collectionId ?? "");
    colSel!.value = cur;
    if (res !== null && cur === "" && s.collectionId != null)
      void setSettings({ collectionId: null });
    if (res === null) statusEl!.textContent = "采集库列表加载失败（选择已保留，稍后再试）";
  }
  colSel.onchange = async () => {
    if (colSel!.value === NEW_OPT) {
      newColRow!.style.display = "";
      newCol!.focus();
      return;
    }
    newColRow!.style.display = "none";
    await setSettings({ collectionId: colSel!.value ? Number(colSel!.value) : null });
    statusEl.textContent = colSel!.value
      ? `采集将进库「${colSel!.selectedOptions[0]?.textContent}」`
      : "采集不分组，进总池";
  };
  newColBtn.onclick = async () => {
    const name = newCol!.value.trim();
    if (!name) return;
    newColBtn.disabled = true;
    try {
      const c = await sendToBackground<{ id: number }>({ type: "CREATE_COLLECTION", name });
      await setSettings({ collectionId: c.id });
      newCol!.value = "";
      newColRow!.style.display = "none";
      await renderCollections();
      colSel!.value = String(c.id);
      statusEl.textContent = `已建库「${name}」，采集自动归入`;
    } catch (e) {
      statusEl.textContent = `建库失败：${String((e as Error)?.message ?? e)}`;
    } finally {
      newColBtn.disabled = false;
    }
  };

  try {
    const s = await sendToBackground<Status>({ type: "GET_STATUS" });
    statusEl.textContent = s.authorized
      ? s.lastDeepCollectFailure
        ? `深度采集失败：${s.lastDeepCollectFailure.error}`
        : `已连接 ${s.appUrl} · 已入库 ${s.collected} 条`
      : "未授权：打开工作台 →「授权插件」";
    if (s.authorized) await renderCollections();
    else colSel!.disabled = true;
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
