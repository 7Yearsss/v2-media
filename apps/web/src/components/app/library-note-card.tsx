import { Check, Heart, ImageOff, Images, MessageCircle, SendToBack, Star } from "lucide-react";
import type { CollectedNote } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { mediaUrl } from "@/lib/api";
import { formatCount, formatDuration } from "@/lib/format";
import { noteBadges, statLabel } from "@/lib/note-insight";
import { cn } from "@/lib/utils";
import { noteKeyHandler } from "@/lib/focus-nav";
import { NoteAvatar } from "./note-avatar";
import { NoteSelectBox } from "./note-select-box";

export function LibraryNoteCard({
  note,
  onOpen,
  onEnqueue,
  enqueuing,
  drafted,
  viewed,
  selected,
  checked,
  selecting,
  onToggle,
  onHover,
  index,
  dragIds,
  hotAt,
}: {
  note: CollectedNote;
  onOpen: () => void;
  onEnqueue: () => void;
  enqueuing: boolean;
  /** 本次已送入草稿。 */
  drafted?: boolean;
  /** 本机打开过。 */
  viewed?: boolean;
  /** 详情面板正在看这一条。 */
  selected: boolean;
  /** 被勾选做批量操作。 */
  checked: boolean;
  /** 已有勾选项：此时点卡片是勾选而不是打开详情，复选框常显。 */
  selecting: boolean;
  onToggle: (range?: boolean) => void;
  /** 鼠标移上来：预取详情。 */
  onHover?: () => void;
  /** 在列表里的位置，方向键导航用。 */
  index?: number;
  /** 开始拖拽时返回要移动的笔记 id（已勾选就是全部勾选项）。 */
  dragIds?: () => number[];
  hotAt: number | null;
}) {
  const cover = mediaUrl(note.cover || note.images[0]?.url);
  const badges = noteBadges(note, hotAt);
  const tags = note.tags.slice(0, 2);
  const incomplete = !note.title && !cover && note.images.length === 0;
  const act = selecting ? () => onToggle() : onOpen;
  return (
    <div className="h-full">
      <div
        role="button"
        aria-label={`${selecting ? "选择" : "查看"}笔记：${note.title || "（无标题）"}`}
        tabIndex={0}
        aria-pressed={selecting ? checked : selected}
        data-note-index={index}
        onClick={(e) => (selecting ? onToggle(e.shiftKey) : onOpen())}
        onKeyDown={noteKeyHandler(act)}
        onPointerEnter={onHover}
        draggable={Boolean(dragIds)}
        onDragStart={(e) => {
          if (!dragIds) return;
          const ids = dragIds();
          e.dataTransfer.setData("application/x-v2m-notes", JSON.stringify(ids));
          e.dataTransfer.effectAllowed = "move";
          if (ids.length > 1) e.dataTransfer.setData("text/plain", `${ids.length} 条笔记`);
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
              decoding="async"
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="grid h-full w-full place-items-center text-muted-foreground">
              <div className="flex flex-col items-center gap-1.5">
                <ImageOff className="size-6" />
                {incomplete ? <span className="rounded-full bg-amber-400/90 px-2 py-0.5 text-[10px] font-medium text-amber-950">采集不完整</span> : null}
              </div>
            </div>
          )}
          <NoteSelectBox
            checked={checked}
            label={`选择笔记：${note.title || "（无标题）"}`}
            onToggle={onToggle}
            className={cn("absolute left-2 top-2", !checked && !selecting && "workspace-hover-actions")}
          />
          <div className="absolute right-2 top-2 flex flex-col items-end gap-1">
            {note.type === "video" ? (
              <span className="rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium tabular-nums text-white">
                视频{note.video?.durationMs ? ` ${formatDuration(note.video.durationMs)}` : ""}
              </span>
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
            <div className="workspace-hover-actions pointer-events-none absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/45 to-transparent p-2 transition-opacity duration-150">
              <Button
                size="sm"
                variant="secondary"
                disabled={enqueuing || drafted}
                onClick={(e) => {
                  e.stopPropagation();
                  onEnqueue();
                }}
                className="pointer-events-auto bg-white/90 text-neutral-900 hover:bg-white"
              >
                {drafted ? <Check className="size-3.5" /> : <SendToBack className="size-3.5" />}
                {drafted ? "已送入草稿" : "送入草稿"}
              </Button>
            </div>
          ) : null}
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className={cn("line-clamp-2 text-sm font-medium leading-5", viewed && !selected ? "text-muted-foreground" : "text-foreground")} title={viewed ? "已看过" : undefined}>
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
    </div>
  );
}
