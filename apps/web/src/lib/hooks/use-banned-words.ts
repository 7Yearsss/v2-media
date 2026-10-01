import { useCallback, useState } from "react";

const KEY = "v2m.bannedWords";

const read = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

/** 用户自己的屏蔽词（品牌禁用语、客户要求避开的词…），记在本机。 */
export function useBannedWords() {
  const [words, setWords] = useState<string[]>(read);
  const save = useCallback((next: string[]) => {
    setWords(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 隐私模式等：不记就不记 */
    }
  }, []);
  const add = useCallback(
    (w: string) => {
      const t = w.trim().slice(0, 20);
      if (t && !words.includes(t)) save([...words, t]);
    },
    [save, words],
  );
  const remove = useCallback((w: string) => save(words.filter((x) => x !== w)), [save, words]);
  return { words, add, remove };
}
