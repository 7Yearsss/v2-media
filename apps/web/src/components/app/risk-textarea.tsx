import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BANNED_KIND_META, type BannedHit } from "@v2media/shared";
import { cn } from "@/lib/utils";

/** 文字排版：输入层和高亮层必须一模一样，高亮才会对得上。 */
const TYPO = "px-1 py-1 text-[15px] leading-7 tracking-normal whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

/**
 * 正文输入框：违禁/限流词直接在文字上高亮（Grammarly 式），点到高亮词弹出建议。
 * 高亮层垫在透明背景的 textarea 后面，textarea 自适应高度所以不用同步滚动。
 */
export function RiskTextarea({
  value,
  onChange,
  hits,
  onFix,
  placeholder,
  ariaLabel,
  textareaRef,
}: {
  value: string;
  onChange: (v: string) => void;
  hits: BannedHit[];
  /** 替换/删除这一处命中（suggest 为空串=删除）。 */
  onFix: (hit: BannedHit) => void;
  placeholder?: string;
  ariaLabel?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? innerRef;
  const layerRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [pop, setPop] = useState<{ hit: BannedHit; x: number; y: number } | null>(null);

  // 自适应高度：内容多高输入框就多高，页面滚动而不是框内滚动
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, 220)}px`;
  }, [value, ref]);

  // 文字变了，旧的弹层位置就不对了
  useEffect(() => setPop(null), [value]);

  const open = () => {
    const el = ref.current;
    if (!el || el.selectionStart !== el.selectionEnd) return setPop(null);
    const caret = el.selectionStart;
    const hit = hits.find((h) => caret >= h.index && caret <= h.index + h.word.length);
    const mark = hit && layerRef.current?.querySelector<HTMLElement>(`[data-i="${hit.index}"]`);
    const wrap = wrapRef.current;
    if (!hit || !mark || !wrap) return setPop(null);
    const r = mark.getBoundingClientRect();
    const w = wrap.getBoundingClientRect();
    setPop({ hit, x: Math.min(r.left - w.left, Math.max(0, w.width - 260)), y: r.bottom - w.top + 6 });
  };

  // 按命中位置把文本切成 普通段 / 高亮段
  const parts: Array<{ text: string; hit?: BannedHit }> = [];
  let at = 0;
  for (const h of hits) {
    if (h.index < at) continue;
    if (h.index > at) parts.push({ text: value.slice(at, h.index) });
    parts.push({ text: value.slice(h.index, h.index + h.word.length), hit: h });
    at = h.index + h.word.length;
  }
  parts.push({ text: value.slice(at) });

  return (
    <div ref={wrapRef} className="relative">
      <div ref={layerRef} aria-hidden className={cn(TYPO, "pointer-events-none absolute inset-0 text-transparent")}>
        {parts.map((p, i) =>
          p.hit ? (
            <mark
              key={i}
              data-i={p.hit.index}
              className={cn(
                "rounded-[3px] text-transparent underline decoration-wavy decoration-1 underline-offset-4",
                p.hit.severity === "high" ? "bg-rose-500/20 decoration-rose-500" : "bg-amber-500/20 decoration-amber-500",
              )}
            >
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
        {"\n"}
      </div>
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onClick={open}
        onKeyUp={(e) => (e.key === "Escape" ? setPop(null) : open())}
        placeholder={placeholder}
        aria-label={ariaLabel}
        spellCheck={false}
        className={cn(TYPO, "relative block w-full resize-none overflow-hidden bg-transparent text-foreground outline-none placeholder:text-muted-foreground/60")}
      />
      {pop && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setPop(null)} />
          <div
            style={{ left: pop.x, top: pop.y }}
            className="absolute z-20 w-64 rounded-2xl border border-border bg-card p-3 text-xs shadow-xl"
          >
            <div className="flex items-center gap-1.5 font-medium">
              <i className={cn("size-2 rounded-full", pop.hit.severity === "high" ? "bg-rose-500" : "bg-amber-500")} />
              {BANNED_KIND_META[pop.hit.kind].label}
            </div>
            <div className="mt-1 leading-5 text-muted-foreground">{BANNED_KIND_META[pop.hit.kind].hint}</div>
            {pop.hit.suggest !== undefined ? (
              <button
                type="button"
                onClick={() => {
                  onFix(pop.hit);
                  setPop(null);
                }}
                className="mt-2.5 w-full rounded-full bg-primary px-3 py-1.5 font-medium text-primary-foreground"
              >
                {pop.hit.suggest ? `改成「${pop.hit.suggest}」` : "删除这个词"}
              </button>
            ) : (
              <div className="mt-2.5 rounded-xl bg-muted px-3 py-1.5 text-muted-foreground">需要你换个说法</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
