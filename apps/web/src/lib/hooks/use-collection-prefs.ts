import { useCallback, useState } from "react";

const KEY = "v2media:library-collection-prefs";
const RECENT_MAX = 12;

interface Prefs {
  pinned: number[];
  /** 最近点过的库，最新在前 */
  recent: number[];
}

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<Prefs> | null;
    return { pinned: raw?.pinned ?? [], recent: raw?.recent ?? [] };
  } catch {
    return { pinned: [], recent: [] };
  }
}

/** 采集库的置顶 / 最近使用（仅存本地浏览器，不同步）。 */
export function useCollectionPrefs() {
  const [prefs, setPrefs] = useState<Prefs>(load);

  const update = useCallback((fn: (p: Prefs) => Prefs) => {
    setPrefs((p) => {
      const next = fn(p);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
      return next;
    });
  }, []);

  const touch = useCallback(
    (id: number) => update((p) => ({ ...p, recent: [id, ...p.recent.filter((x) => x !== id)].slice(0, RECENT_MAX) })),
    [update],
  );
  const togglePin = useCallback(
    (id: number) =>
      update((p) => ({ ...p, pinned: p.pinned.includes(id) ? p.pinned.filter((x) => x !== id) : [...p.pinned, id] })),
    [update],
  );

  return { pinned: prefs.pinned, recent: prefs.recent, touch, togglePin };
}
