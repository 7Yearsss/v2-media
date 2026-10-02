import { useCallback, useState } from "react";
import { captureUserStorage } from "../user-storage";

const KEY = "v2m.bannedWords";

const read = (storage: ReturnType<typeof captureUserStorage>): string[] => {
  try {
    const v = JSON.parse(storage.getItem() ?? "[]");
    return Array.isArray(v) ? v.map(String).filter(Boolean) : [];
  } catch {
    return [];
  }
};

/** 用户自己的屏蔽词（品牌禁用语、客户要求避开的词…），记在本机。 */
export function useBannedWords() {
  const [storage] = useState(() => captureUserStorage(KEY));
  const [words, setWords] = useState<string[]>(() => read(storage));
  const save = useCallback((next: string[]) => {
    setWords(next);
    storage.setItem(JSON.stringify(next));
  }, [storage]);
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
