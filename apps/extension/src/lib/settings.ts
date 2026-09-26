/**
 * 插件启停开关（chrome.storage.local.v2m_settings）：
 *  - enabled=false：心跳/轮询/采集/注入 UI 全停，等价于插件暂时关闭
 *  - autoCollect=false：只停「浏览即采集」，手动点卡片按钮/一键入库仍可用
 *  - deepCollect=true：采集时后台开隐藏标签页进详情页，补采评论
 */

export interface ExtSettings {
  enabled: boolean;
  autoCollect: boolean;
  /** 当前采集库 id（null/undefined = 不分组进总池）。 */
  collectionId?: number | null;
  /** 深度采集：采集后自动开隐藏页补评论（默认关，开销大且更易触风控）。 */
  deepCollect?: boolean;
}

const KEY = "v2m_settings";
const DEFAULTS: ExtSettings = {
  enabled: true,
  autoCollect: true,
  collectionId: null,
  deepCollect: false,
};

export async function getSettings(): Promise<ExtSettings> {
  const { [KEY]: s } = (await chrome.storage.local.get(KEY)) as {
    [KEY]?: Partial<ExtSettings>;
  };
  return { ...DEFAULTS, ...s };
}

export async function setSettings(patch: Partial<ExtSettings>): Promise<void> {
  const cur = await getSettings();
  await chrome.storage.local.set({ [KEY]: { ...cur, ...patch } });
}

export function onSettingsChanged(cb: (s: ExtSettings) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[KEY]) return;
    const next = changes[KEY].newValue as Partial<ExtSettings> | undefined;
    cb({ ...DEFAULTS, ...next });
  });
}
