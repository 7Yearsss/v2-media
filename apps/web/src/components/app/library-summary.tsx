import { Hash, Heart, MessageCircle, NotebookText, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { NotesSummary } from "@v2media/shared";
import { NumberTicker } from "@/components/motion/number-ticker";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 当前筛选范围的统计：条数 / 互动合计（收藏、评论没采全时是下限，标 +）。 */
export function LibraryStats({ summary }: { summary: NotesSummary }) {
  if (summary.notes === 0) return null;
  const partial = summary.withDetail < summary.notes;
  const partialHint = `收藏/评论只统计已采详情的 ${summary.withDetail} / ${summary.notes} 条，实际更高`;
  const stats = [
    { icon: NotebookText, label: "笔记", value: summary.notes, format: undefined, plus: false, hint: "" },
    { icon: Heart, label: "点赞", value: summary.likes, format: formatCount, plus: false, hint: "" },
    { icon: Star, label: "收藏", value: summary.collects, format: formatCount, plus: partial, hint: partial ? partialHint : "" },
    { icon: MessageCircle, label: "评论", value: summary.comments, format: formatCount, plus: partial, hint: partial ? partialHint : "" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
      {stats.map(({ icon: Icon, label, value, format, plus, hint }) => (
        <span key={label} title={hint || undefined} className="inline-flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 self-center" />
          {label}
          <b className="text-sm font-semibold text-foreground">
            <NumberTicker value={value} locale={!format} format={format} suffix={plus ? "+" : undefined} startOnView={false} duration={0.7} />
          </b>
        </span>
      ))}
    </div>
  );
}

/** 「话题」按钮 + 弹层：热门话题列表，点一个即按话题筛选（再点取消）。 */
export function LibraryTopics({
  summary,
  activeTag,
  onTag,
}: {
  summary: NotesSummary;
  activeTag: string;
  onTag: (tag: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  if (summary.topTags.length === 0 && !activeTag) return null;
  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          activeTag ? "border-primary/60 bg-primary/10 text-primary" : "border-border bg-background text-muted-foreground hover:text-foreground",
        )}
      >
        <Hash className="size-3.5" />
        {activeTag ? <span className="max-w-24 truncate">{activeTag}</span> : "话题"}
      </button>
      {open ? (
        <div role="listbox" className="absolute right-0 top-full z-30 mt-1.5 max-h-80 w-64 overflow-y-auto rounded-xl border border-border bg-background p-1.5 shadow-lg">
          {activeTag ? (
            <button type="button" onClick={() => { onTag(""); setOpen(false); }} className="mb-1 w-full rounded-lg px-3 py-2 text-left text-xs text-primary hover:bg-muted">
              清除话题筛选
            </button>
          ) : null}
          {summary.topTags.map((t) => (
            <button
              key={t.tag}
              type="button"
              role="option"
              aria-selected={activeTag === t.tag}
              onClick={() => { onTag(activeTag === t.tag ? "" : t.tag); setOpen(false); }}
              className={cn("flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring", activeTag === t.tag && "bg-muted font-medium")}
            >
              <span className="truncate">#{t.tag}</span>
              <span className="ml-auto shrink-0 tabular-nums text-xs text-muted-foreground">{t.notes}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
