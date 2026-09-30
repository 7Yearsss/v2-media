import { Check, ChevronLeft, ExternalLink, Heart, MessageCircle, MoreHorizontal, Pencil, SendToBack, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/motion/button";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { PageError, PageLoading } from "@/components/app/states";
import { api, mediaUrl, noteComments } from "@/lib/api";
import { formatCount, timeAgo } from "@/lib/format";
import { commentDate, xhsEmoji } from "@/lib/xhs-text";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";
import { NoteImageGallery } from "./note-image-gallery";
import { NoteAvatar } from "./note-avatar";
import type { NoteComment } from "@v2media/shared";

/** 一条评论（主评论与回复共用）：昵称 + 作者标记、正文、图片、日期属地、点赞。 */
function CommentItem({ comment, authorId, small }: { comment: NoteComment; authorId: string; small?: boolean }) {
  const isAuthor = comment.isAuthor || (Boolean(authorId) && comment.userId === authorId);
  const meta = [commentDate(comment.createdAt), comment.ipLocation].filter(Boolean).join(" ");
  return (
    <div className="flex gap-2.5">
      <NoteAvatar name={comment.userName} src={comment.avatar} className={small ? "size-7 text-[10px]" : "size-9 text-xs"} />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1.5 text-[13px] text-muted-foreground">
          <span className="truncate">{comment.userName || "未知用户"}</span>
          {isAuthor ? <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] leading-4 text-primary">作者</span> : null}
        </p>
        <p className="mt-0.5 whitespace-pre-wrap break-words text-[15px] leading-6 text-foreground">{xhsEmoji(comment.content)}</p>
        {comment.pictures?.length ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {comment.pictures.map((url, i) => (
              <a key={`${url}-${i}`} href={mediaUrl(url)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <img src={mediaUrl(url)} alt="评论图片" loading="lazy" decoding="async" className="size-24 object-cover" />
              </a>
            ))}
          </div>
        ) : null}
        <div className="mt-1 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span className="truncate">{meta}</span>
          <span className="inline-flex shrink-0 items-center gap-1 tabular-nums"><Heart className="size-3.5" />{comment.likes > 0 ? formatCount(comment.likes) : "赞"}</span>
        </div>
      </div>
    </div>
  );
}

function CommentReplies({ replies, total, authorId }: { replies: NoteComment[]; total?: number; authorId: string }) {
  const [expanded, setExpanded] = useState(false);
  const missing = total && total > replies.length ? total - replies.length : 0;
  return (
    <div className="mt-2">
      {expanded ? (
        <ul className="space-y-4 py-2">
          {replies.map((reply, index) => (
            <li key={reply.commentId ?? index}><CommentItem comment={reply} authorId={authorId} small /></li>
          ))}
          {missing ? <li className="pl-9 text-xs text-muted-foreground">还有 {missing} 条回复未采集（可在原笔记查看）</li> : null}
        </ul>
      ) : null}
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="inline-flex min-h-8 items-center gap-2 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden="true" className="h-px w-5 bg-border" />
        {expanded ? "收起回复" : `展开 ${total && total > replies.length ? total : replies.length} 条回复${missing ? `（已采 ${replies.length}）` : ""}`}
      </button>
    </div>
  );
}

/** 顶栏右侧「⋯」：原笔记 / 删除。 */
function NoteMenu({ sourceUrl, onDelete }: { sourceUrl?: string; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); } };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("mousedown", onDown); window.removeEventListener("keydown", onKey, true); };
  }, [open]);
  const item = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:bg-muted";
  return (
    <div ref={rootRef} className="relative">
      <button type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} className="grid size-9 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <MoreHorizontal className="size-5" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-40 rounded-xl border border-border bg-background p-1 shadow-lg">
          {sourceUrl ? (
            <a role="menuitem" href={sourceUrl} target="_blank" rel="noreferrer" onClick={() => setOpen(false)} className={item}><ExternalLink className="size-4" />原笔记</a>
          ) : null}
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onDelete(); }} className={cn(item, "text-destructive")}><Trash2 className="size-4" />删除</button>
        </div>
      ) : null}
    </div>
  );
}

/** A sibling of the library, so browsing and filters remain available. */
export function LibraryNoteDetail({ noteId, onClose }: { noteId: number; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const commentsRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showAllComments, setShowAllComments] = useState(false);
  const detail = useQuery({ queryKey: ["note", noteId], queryFn: () => api.note(noteId) });

  useEffect(() => {
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected &&
          (panel?.contains(document.activeElement) || document.activeElement === document.body)) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [onClose]);

  const enqueue = useMutation({
    mutationFn: () => api.createDraft({ collectedNoteId: noteId }),
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      toast.success("已送入草稿工坊", draft.title || "未命名草稿");
      onClose();
      navigate(`/drafts/${draft.id}`);
    },
    onError: (err) => toast.error("送入草稿失败", err instanceof Error ? err.message : undefined),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteNote(noteId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      toast.success("已从内容库删除");
      onClose();
    },
    onError: (err) => toast.error("删除失败", err instanceof Error ? err.message : undefined),
  });
  const note = detail.data;
  const images = note?.images.length ? note.images : note?.cover ? [{ url: note.cover }] : [];
  const isVideo = note?.type === "video" && Boolean(note.videoUrl);
  const comments = noteComments(note);
  const replies = comments.reduce((count, comment) => count + (comment.subComments?.length ?? 0), 0);

  return (
    <aside ref={panelRef} aria-label="笔记详情" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-muted/40 lg:w-[480px] lg:shrink-0 lg:border-l lg:border-border">
      {/* 手机画布：内容固定在约 390px 宽的列里，看到的就是手机上的排布 */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-[420px] flex-col overflow-hidden bg-white dark:bg-[#19191f] lg:border-x lg:border-border/60">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/50 px-3 py-3">
        <h2 className="sr-only">笔记详情</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭笔记详情" className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronLeft className="size-5" />
        </button>
        <NoteAvatar name={note?.authorName || ""} src={note?.authorAvatar} className="size-9 text-sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-foreground">{note?.authorName || "笔记详情"}</p>
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            {note ? <>{timeAgo(note.savedAt)}采集<Check className="size-3 text-emerald-500" />已入库</> : "正在加载"}
          </p>
        </div>
        {note ? (
          <>
            <Button size="sm" disabled={enqueue.isPending} onClick={() => enqueue.mutate()}><SendToBack className="size-3.5" />送入草稿</Button>
            <NoteMenu sourceUrl={note.sourceUrl} onDelete={() => setConfirmDelete(true)} />
          </>
        ) : null}
      </header>
      {detail.isPending ? <PageLoading label="加载笔记详情…" className="min-h-0 flex-1" /> : detail.isError || !note ? (
        <PageError error={detail.error} onRetry={detail.refetch} className="min-h-0 flex-1" />
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] lg:[scrollbar-width:thin]" aria-label="笔记详情内容">
            {isVideo ? (
              <video
                key={note.videoUrl}
                src={mediaUrl(note.videoUrl)}
                poster={mediaUrl(note.cover) || undefined}
                controls
                playsInline
                preload="metadata"
                className="block max-h-[70vh] w-full bg-black object-contain"
              />
            ) : images.length ? <NoteImageGallery images={images} /> : null}
            <div className="space-y-6 px-4 pb-8 pt-4">
              <section aria-label="笔记正文" className="space-y-3">
                <h3 className="break-words text-lg font-semibold leading-7 text-foreground">{note.title || "（无标题）"}</h3>
                {note.content ? <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground">{xhsEmoji(note.content)}</p> : <p className="text-sm text-muted-foreground">暂未采集到正文</p>}
                {note.tags.length ? <div className="flex flex-wrap gap-x-2 gap-y-0.5">{note.tags.map(tag => <span key={tag} className="text-[15px] leading-7 text-sky-700 dark:text-sky-300">#{tag}</span>)}</div> : null}
                {(note.publishedAt || note.ipLocation) ? <p className="pt-1 text-xs text-muted-foreground">{note.publishedAt ? new Date(note.publishedAt).toLocaleDateString("zh-CN") : ""}{note.ipLocation ? ` ${note.ipLocation}` : ""}</p> : null}
              </section>
              <section ref={commentsRef} aria-label="笔记评论" className="border-t border-border pt-5">
                <h4 className="text-sm font-semibold text-foreground">共 {formatCount(note.comments)} 条评论</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">已采 {comments.length} 条主评论{replies ? `、${replies} 条回复` : ""} · 平台显示 {formatCount(note.comments)} 条评论</p>
                {comments.length ? (
                  <ul className="mt-5 space-y-6">
                    {(showAllComments ? comments : comments.slice(0, 20)).map((comment, index) => (
                      <li key={comment.commentId ?? index}>
                        <CommentItem comment={comment} authorId={note.authorId} />
                        {comment.subComments?.length || comment.subCommentCount ? (
                          <div className="pl-[46px]">
                            <CommentReplies replies={comment.subComments ?? []} total={comment.subCommentCount} authorId={note.authorId} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-sm text-muted-foreground">尚未采集评论明细</p>}
                {comments.length > 20 ? <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setShowAllComments(value => !value)}>{showAllComments ? "收起评论" : `展开全部 ${comments.length} 条主评论`}</Button> : null}
              </section>
            </div>
          </div>
          {/* 底栏对齐手机：输入条占位 + 点赞 / 收藏 / 评论 */}
          <footer className="flex shrink-0 items-center gap-3 border-t border-border/60 bg-white px-3 py-2.5 dark:bg-[#19191f]">
            <span aria-hidden="true" className="inline-flex h-9 min-w-0 flex-1 items-center gap-1.5 rounded-full bg-muted px-3.5 text-sm text-muted-foreground"><Pencil className="size-3.5 shrink-0" />说点什么…</span>
            <span aria-label={`${note.likes} 个赞`} className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-foreground"><Heart className="size-6" strokeWidth={1.5} />{formatCount(note.likes)}</span>
            <span aria-label={`${note.collects} 次收藏`} className="inline-flex shrink-0 items-center gap-1 text-sm tabular-nums text-foreground"><Star className="size-6" strokeWidth={1.5} />{formatCount(note.collects)}</span>
            <button type="button" aria-label="查看已采评论" onClick={() => {
              const scroll = scrollRef.current;
              const section = commentsRef.current;
              if (scroll && section) scroll.scrollTo({ top: scroll.scrollTop + section.getBoundingClientRect().top - scroll.getBoundingClientRect().top, behavior: "smooth" });
            }} className="inline-flex min-h-9 shrink-0 items-center gap-1 rounded-lg text-sm tabular-nums text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"><MessageCircle className="size-6" strokeWidth={1.5} />{formatCount(note.comments)}</button>
          </footer>
        </>
      )}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title="从内容库删除这条笔记？"
        description="此操作不可恢复。"
        confirmLabel="删除"
        destructive
        busy={remove.isPending}
        onConfirm={() => { setConfirmDelete(false); remove.mutate(); }}
      />
    </aside>
  );
}
