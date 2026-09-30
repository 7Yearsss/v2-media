import { Heart, MessageCircle, NotebookText, Star } from "lucide-react";
import type { NotesSummary } from "@v2media/shared";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

/** 当前筛选范围的摘要条：条数 / 互动合计 / 热门话题（点话题即按话题筛选）。 */
export function LibrarySummary({
  summary,
  activeTag,
  onTag,
}: {
  summary: NotesSummary;
  activeTag: string;
  onTag: (tag: string) => void;
}) {
  if (summary.notes === 0) return null;
  // 收藏/评论只有详情页才有：没采全时合计只是下限，标注出来
  const partial = summary.withDetail < summary.notes;
  const partialHint = `收藏/评论只统计已采详情的 ${summary.withDetail} / ${summary.notes} 条，实际更高`;
  const stats = [
    { icon: NotebookText, label: "笔记", value: summary.notes.toLocaleString(), hint: "" },
    { icon: Heart, label: "点赞", value: formatCount(summary.likes), hint: "" },
    { icon: Star, label: "收藏", value: `${formatCount(summary.collects)}${partial ? "+" : ""}`, hint: partial ? partialHint : "" },
    { icon: MessageCircle, label: "评论", value: `${formatCount(summary.comments)}${partial ? "+" : ""}`, hint: partial ? partialHint : "" },
  ];
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-xl border border-border bg-muted/30 px-4 py-2.5">
      {stats.map(({ icon: Icon, label, value, hint }) => (
        <span key={label} title={hint || undefined} className="inline-flex items-baseline gap-1.5 text-xs text-muted-foreground">
          <Icon className="size-3.5 self-center" />
          {label}
          <b className="text-sm font-semibold tabular-nums text-foreground">{value}</b>
        </span>
      ))}
      {summary.topTags.length > 0 ? (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5 sm:ml-auto">
          <span className="text-xs text-muted-foreground">热门话题</span>
          {summary.topTags.map((t) => (
            <button
              key={t.tag}
              type="button"
              aria-pressed={activeTag === t.tag}
              onClick={() => onTag(activeTag === t.tag ? "" : t.tag)}
              className={cn(
                "rounded-full px-2 py-0.5 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring",
                activeTag === t.tag ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:text-foreground",
              )}
            >
              #{t.tag} <span className="tabular-nums opacity-70">{t.notes}</span>
            </button>
          ))}
        </span>
      ) : null}
    </div>
  );
}
