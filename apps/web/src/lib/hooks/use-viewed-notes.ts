import { useCallback, useMemo, useState } from "react";

const KEY = "v2media:viewed-notes";
const MAX = 500;

function load(): number[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((n): n is number => typeof n === "number") : [];
  } catch {
    return [];
  }
}

/** 本机打开过的笔记 id（localStorage，最多 500 条）：卡片上标"已看"，方便在大量笔记里回头找。 */
export function useViewedNotes() {
  const [ids, setIds] = useState<number[]>(load);
  const set = useMemo(() => new Set(ids), [ids]);
  const mark = useCallback((id: number) => {
    setIds((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id].slice(-MAX);
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* Storage can be unavailable. */ }
      return next;
    });
  }, []);
  const has = useCallback((id: number) => set.has(id), [set]);
  return useMemo(() => ({ has, mark }), [has, mark]);
}
