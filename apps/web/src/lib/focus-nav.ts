/**
 * 内容库方向键导航：在已渲染的 [data-note-index] 元素里，按屏幕位置找上 / 下 / 左 / 右最近的一个并聚焦。
 * 网格是瀑布流（列数不定），所以不按下标算，而按几何位置找；列表视图天然退化成上下一行。
 */
export function focusNeighbor(from: HTMLElement, dir: "up" | "down" | "left" | "right"): boolean {
  const r = from.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const el of document.querySelectorAll<HTMLElement>("[data-note-index]")) {
    if (el === from) continue;
    const b = el.getBoundingClientRect();
    const ex = b.left + b.width / 2, ey = b.top + b.height / 2;
    const dx = ex - cx, dy = ey - cy;
    const ok =
      dir === "down" ? b.top >= r.bottom - 8 :
      dir === "up" ? b.bottom <= r.top + 8 :
      dir === "right" ? b.left >= r.right - 8 && Math.abs(dy) < Math.max(r.height, b.height) * 0.6 :
      b.right <= r.left + 8 && Math.abs(dy) < Math.max(r.height, b.height) * 0.6;
    if (!ok) continue;
    // 主方向距离为主、横向偏移为辅
    const score = dir === "up" || dir === "down" ? Math.abs(dy) + Math.abs(dx) * 2 : Math.abs(dx) + Math.abs(dy) * 2;
    if (score < bestScore) { best = el; bestScore = score; }
  }
  if (!best) return false;
  best.focus();
  best.scrollIntoView({ block: "nearest" });
  return true;
}

/** 卡片 / 行共用的键盘处理：Enter、空格触发 act；方向键移动焦点。 */
export function noteKeyHandler(act: () => void) {
  return (e: { target: EventTarget; currentTarget: HTMLElement; key: string; preventDefault: () => void }) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      act();
      return;
    }
    const dir = e.key === "ArrowDown" ? "down" : e.key === "ArrowUp" ? "up" : e.key === "ArrowLeft" ? "left" : e.key === "ArrowRight" ? "right" : null;
    if (dir && focusNeighbor(e.currentTarget, dir)) e.preventDefault();
  };
}
