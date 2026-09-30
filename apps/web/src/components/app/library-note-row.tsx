import { Heart, ImageOff, MessageCircle, SendToBack, Star } from "lucide-react";
import type { CollectedNote } from "@v2media/shared";
import { mediaUrl } from "@/lib/api";
import { formatCount, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { NoteAvatar } from "./note-avatar";

export const NOTE_ROW_COLUMNS = "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 @[900px]:grid-cols-[minmax(0,1fr)_110px_180px_86px_86px_32px]";

function dateLabel(value?: string | null) {
  return value ? new Date(value).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }) : "未采到";
}

export function LibraryNoteRow({ note, selected, onOpen, onEnqueue, enqueuing }: {
  note: CollectedNote; selected: boolean; onOpen: () => void; onEnqueue: () => void; enqueuing: boolean;
}) {
  const cover = mediaUrl(note.cover || note.images[0]?.url);
  return <div role="button" tabIndex={0} aria-label={`查看笔记：${note.title || "（无标题）"}`} aria-pressed={selected}
    onClick={onOpen} onKeyDown={event => {
      if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onOpen(); }
    }}
    className={cn(NOTE_ROW_COLUMNS, "h-20 cursor-pointer border-b border-border/60 px-3 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring", selected && "bg-primary/8 shadow-[inset_3px_0_0_var(--color-primary)]")}>
    <div className="flex min-w-0 items-center gap-3">
      <div className="relative grid h-14 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
        {cover ? <img src={cover} alt="" loading="lazy" decoding="async" className="h-full w-full object-cover" /> : <ImageOff className="size-4 text-muted-foreground" />}
        {note.type === "video" ? <span className="absolute inset-x-0 bottom-0 bg-black/60 text-center text-[9px] text-white">视频</span> : null}
      </div>
      <div className="min-w-0">
        <p className="line-clamp-2 text-sm font-medium leading-5 text-foreground" title={note.title}>{note.title || "（无标题）"}</p>
        <p className="mt-1 truncate text-[11px] text-muted-foreground @[900px]:hidden" title={`作者：${note.authorName || "未知作者"}；最近采集：${new Date(note.savedAt).toLocaleString("zh-CN")}；原笔记发布：${note.publishedAt ? new Date(note.publishedAt).toLocaleString("zh-CN") : "未采到"}`}>{note.authorName || "未知作者"} · 采集 {dateLabel(note.savedAt)} · 发布 {dateLabel(note.publishedAt)}</p>
      </div>
    </div>
    <div className="hidden min-w-0 items-center gap-1.5 @[900px]:flex">
      <NoteAvatar name={note.authorName} src={note.authorAvatar} className="size-5 text-[9px]" />
      <span className="truncate text-xs text-muted-foreground" title={note.authorName}>{note.authorName || "未知作者"}</span>
    </div>
    <div className="grid grid-cols-3 gap-2 text-[11px] tabular-nums text-muted-foreground @[900px]:text-xs">
      {([{ icon: Heart, value: note.likes, label: "点赞" }, { icon: Star, value: note.collects, label: "收藏" }, { icon: MessageCircle, value: note.comments, label: "评论" }]).map(({ icon: Icon, value, label }) =>
        <span key={label} aria-label={`${label} ${value}`} className="inline-flex items-center justify-end gap-1" title={`${label} ${value}`}><Icon className="size-3 shrink-0" />{formatCount(value)}</span>)}
    </div>
    <span className="hidden text-right text-[11px] text-muted-foreground @[900px]:block" title={new Date(note.savedAt).toLocaleString("zh-CN")}>{timeAgo(note.savedAt)}</span>
    <span className="hidden text-right text-[11px] tabular-nums text-muted-foreground @[900px]:block" title={note.publishedAt ? new Date(note.publishedAt).toLocaleString("zh-CN") : "未采到原笔记发布时间；再次采集详情可补充"}>{note.publishedAt ? new Date(note.publishedAt).toLocaleDateString("zh-CN") : "未采到"}</span>
    <button type="button" aria-label={`送入草稿：${note.title || "（无标题）"}`} title="送入草稿" disabled={enqueuing}
      onClick={event => { event.stopPropagation(); onEnqueue(); }}
      className="hidden size-8 place-items-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 @[900px]:grid"><SendToBack className="size-4" /></button>
  </div>;
}
