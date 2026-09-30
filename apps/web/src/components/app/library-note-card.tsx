import { Heart, ImageOff, Images, MessageCircle, SendToBack, Star } from "lucide-react";
import type { CollectedNote } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { TiltCard } from "@/components/motion/tilt-card";
import { mediaUrl } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { noteBadges, statLabel } from "@/lib/note-insight";
import { cn } from "@/lib/utils";
import { NoteAvatar } from "./note-avatar";
import { NoteSelectBox } from "./note-select-box";

export function LibraryNoteCard({
  note,
  onOpen,
  onEnqueue,
  enqueuing,
  selected,
  checked,
  selecting,
  onToggle,
  hotAt,
}: {
  note: CollectedNote;
  onOpen: () => void;
  onEnqueue: () => void;
  enqueuing: boolean;
  /** 详情面板正在看这一条。 */
  selected: boolean;
  /** 被勾选做批量操作。 */
  checked: boolean;
  /** 已有勾选项：此时点卡片是勾选而不是打开详情，复选框常显。 */
  selecting: boolean;
  onToggle: () => void;
  hotAt: number | null;
}) {
  const cover = mediaUrl(note.cover || note.images[0]?.url);
  const badges = noteBadges(note, hotAt);
  const tags = note.tags.slice(0, 2);
  const act = selecting ? onToggle : onOpen;
  return (
    <TiltCard max={6} glare={false} className="h-full">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selecting ? checked : selected}
        onClick={act}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            act();
          }
        }}
        className={cn(
          "group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          checked || selected ? "border-primary ring-2 ring-primary/15" : "border-border hover:border-foreground/20",
        )}
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
          {cover ? (
            <img
              src={cover}
              alt={note.title}
              loading="lazy"
              className="h-full w-full object-cover transition-transform duration-500 group-hover:scale-[1.03]"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted-foreground">
              <ImageOff className="size-6" />
            </div>
          )}
          <NoteSelectBox
            checked={checked}
            label={`选择笔记：${note.title || "（无标题）"}`}
            onToggle={onToggle}
            className={cn("absolute left-2 top-2", !checked && !selecting && "opacity-0 group-hover:opacity-100")}
          />
          <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
            {note.type === "video" ? (
              <span className="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">视频</span>
            ) : note.images.length > 1 ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">
                <Images className="size-3" />
                {note.images.length}
              </span>
            ) : null}
          </div>
          {badges.length > 0 ? (
            <div className="absolute bottom-2 left-2 flex gap-1">
              {badges.map((b) => (
                <span
                  key={b.key}
                  title={b.hint}
                  className={cn(
                    "rounded-full px-2 py-0.5 text-[10px] font-semibold shadow-sm",
                    b.key === "hot" ? "bg-primary text-primary-foreground" : "bg-amber-400 text-amber-950",
                  )}
                >
                  {b.label}
                </span>
              ))}
            </div>
          ) : null}
          {!selecting ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/45 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
              <Button
                size="sm"
                variant="secondary"
                disabled={enqueuing}
                onClick={(e) => {
                  e.stopPropagation();
                  onEnqueue();
                }}
                className="pointer-events-auto bg-white/90 text-neutral-900 hover:bg-white"
              >
                <SendToBack className="size-3.5" />
                送入草稿
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="line-clamp-2 text-sm font-medium leading-5 text-foreground">
            {note.title || "（无标题）"}
          </p>
          {tags.length > 0 || note.sourceKeyword ? (
            <div className="flex flex-wrap gap-1">
              {note.sourceKeyword ? (
                <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary" title="采集时的搜索词">
                  搜 {note.sourceKeyword}
                </span>
              ) : null}
              {tags.map((t) => (
                <span key={t} className="max-w-full truncate rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  #{t}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-auto flex items-center gap-1.5">
            {note.authorName ? (
              <>
                <NoteAvatar name={note.authorName} src={note.authorAvatar} className="size-4 text-[9px]" />
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{note.authorName}</span>
              </>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            <span className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground" title="点赞">
              <Heart className="size-3" />
              {formatCount(note.likes)}
            </span>
            <span
              className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"
              title={statLabel(note, "collects") === "—" ? "收藏数未采到，采集详情后补全" : "收藏"}
            >
              <Star className="size-3" />
              {statLabel(note, "collects")}
            </span>
            <span
              className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground"
              title={statLabel(note, "comments") === "—" ? "评论数未采到，采集详情后补全" : "评论"}
            >
              <MessageCircle className="size-3" />
              {statLabel(note, "comments")}
            </span>
          </div>
        </div>
      </div>
    </TiltCard>
  );
}
