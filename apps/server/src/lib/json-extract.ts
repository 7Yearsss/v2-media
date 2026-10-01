/**
 * 扫出文本里所有括号配平的 {...}（会识别字符串里的括号和转义）。
 * 模型常在 JSON 前后加说明，甚至先写草稿再写终稿，所以不能用“第一个 { 到最后一个 }”。
 */
export function jsonObjectsIn(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue;
    let depth = 0;
    let inStr = false;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (inStr) {
        if (ch === "\\") j++;
        else if (ch === '"') inStr = false;
      } else if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        out.push(text.slice(i, j + 1));
        i = j;
        break;
      }
    }
  }
  return out;
}
