import { Bookmark, Heart, ImageOff, MessageCircle } from "lucide-react";
import type { NoteImage } from "@v2media/shared";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

/** 把草稿渲染成小红书笔记卡片样式（发布预览）。 */
export function XhsNotePreview({
  title,
  content,
  tags,
  images,
  nickname = "我",
  avatar,
  className,
}: {
  title: string;
  content: string;
  tags: string[];
  images: NoteImage[];
  nickname?: string;
  avatar?: string;
  className?: string;
}) {
  const cover = images[0]?.url;
  return (
    <div
      className={cn(
        "overflow-hidden rounded-2xl border border-border bg-card shadow-sm",
        className,
      )}
    >
      <div className="relative aspect-[4/3] w-full overflow-hidden bg-muted">
        {cover ? (
          <img
            src={mediaUrl(cover)}
            alt={title || "笔记封面"}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="grid h-full w-full place-items-center text-muted-foreground">
            <ImageOff className="size-6" />
          </div>
        )}
        {images.length > 1 ? (
          <span className="absolute right-2 top-2 rounded-full bg-black/50 px-2 py-0.5 text-[10px] font-medium text-white tabular-nums">
            1/{images.length}
          </span>
        ) : null}
      </div>

      <div className="space-y-2.5 p-3.5">
        <p className="line-clamp-2 text-[15px] font-semibold leading-6 text-foreground">
          {title || "标题会显示在这里"}
        </p>
        <p className="line-clamp-4 whitespace-pre-wrap text-[13px] leading-5 text-muted-foreground">
          {content || "正文预览…"}
        </p>
        {tags.length > 0 ? (
          <p className="line-clamp-2 text-[13px] leading-5 text-primary">
            {tags.map((t) => `#${t}`).join(" ")}
          </p>
        ) : null}
        <div className="flex items-center gap-2 pt-1">
          {avatar ? (
            <img
              src={mediaUrl(avatar)}
              alt={nickname}
              className="size-6 rounded-full object-cover"
            />
          ) : (
            <span className="grid size-6 place-items-center rounded-full bg-primary/15 text-[10px] font-semibold text-primary">
              {nickname.slice(0, 1)}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
            {nickname}
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Heart className="size-3.5" /> 0
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <MessageCircle className="size-3.5" /> 0
          </span>
          <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
            <Bookmark className="size-3.5" /> 0
          </span>
        </div>
      </div>
    </div>
  );
}
