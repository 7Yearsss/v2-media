import { Check, ChevronLeft, ExternalLink, Heart, MessageCircle, SendToBack, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button, ButtonLink } from "@/components/motion/button";
import { PageError, PageLoading } from "@/components/app/states";
import { api, noteComments } from "@/lib/api";
import { formatCount, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";
import { NoteImageGallery } from "./note-image-gallery";
import { NoteAvatar } from "./note-avatar";
import type { NoteComment } from "@v2media/shared";

function CommentReplies({ replies }: { replies: NoteComment[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="mt-2">
      {expanded ? (
        <ul className="space-y-4 py-2">
          {replies.map((reply, index) => (
            <li key={reply.commentId ?? index} className="flex gap-2">
              <NoteAvatar name={reply.userName} src={reply.avatar} className="size-6 text-[10px]" />
              <div className="min-w-0 flex-1">
                <p className="text-xs text-muted-foreground">{reply.userName || "未知用户"}</p>
                <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6 text-foreground">{reply.content}</p>
                <span className="mt-1 inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><Heart className="size-3" />{formatCount(reply.likes)}</span>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(value => !value)} className="inline-flex min-h-8 items-center gap-2 rounded text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <span aria-hidden="true" className="h-px w-5 bg-border" />
        {expanded ? "收起回复" : `展开 ${replies.length} 条已采回复`}
      </button>
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
  const comments = noteComments(note);
  const replies = comments.reduce((count, comment) => count + (comment.subComments?.length ?? 0), 0);

  return (
    <aside ref={panelRef} aria-label="笔记详情" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-white dark:bg-[#19191f] lg:w-[44%] lg:shrink-0 lg:border-l lg:border-border xl:w-[480px] 2xl:w-[560px]">
      <header className="flex shrink-0 items-center gap-3 border-b border-border/50 px-4 py-3.5">
        <h2 className="sr-only">笔记详情</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭笔记详情" className="grid size-9 shrink-0 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          <ChevronLeft className="size-5" />
        </button>
        <NoteAvatar name={note?.authorName || ""} src={note?.authorAvatar} className="size-9 text-sm" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium text-foreground">{note?.authorName || "笔记详情"}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{note ? `${timeAgo(note.savedAt)}采集` : "正在加载"}</p>
        </div>
        {note ? <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"><Check className="size-3.5 text-emerald-500" />已入库</span> : null}
      </header>
      {detail.isPending ? <PageLoading label="加载笔记详情…" className="min-h-0 flex-1" /> : detail.isError || !note ? (
        <PageError error={detail.error} onRetry={detail.refetch} className="min-h-0 flex-1" />
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] lg:[scrollbar-width:thin]" aria-label="笔记详情内容">
            {images.length ? <NoteImageGallery images={images} /> : null}
            <div className="space-y-6 px-5 pb-8 pt-4">
              <section aria-label="笔记正文" className="space-y-3">
                <h3 className="break-words text-lg font-semibold leading-7 text-foreground">{note.title || "（无标题）"}</h3>
                {note.content ? <p className="whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground">{note.content}</p> : <p className="text-sm text-muted-foreground">暂未采集到正文</p>}
                {note.tags.length ? <div className="flex flex-wrap gap-1.5">{note.tags.map(tag => <span key={tag} className="text-[15px] leading-7 text-sky-700 dark:text-sky-300">#{tag}</span>)}</div> : null}
                {(note.publishedAt || note.ipLocation) ? <p className="pt-1 text-xs text-muted-foreground">{note.publishedAt ? new Date(note.publishedAt).toLocaleDateString("zh-CN") : ""}{note.ipLocation ? ` ${note.ipLocation}` : ""}</p> : null}
              </section>
              <section ref={commentsRef} aria-label="笔记评论" className="border-t border-border pt-5">
                <h4 className="text-sm font-semibold text-foreground">共 {formatCount(note.comments)} 条评论</h4>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">已采 {comments.length} 条主评论{replies ? `、${replies} 条回复` : ""} · 平台显示 {formatCount(note.comments)} 条评论</p>
                {comments.length ? (
                  <ul className="mt-5 space-y-6">
                    {(showAllComments ? comments : comments.slice(0, 20)).map((comment, index) => (
                      <li key={comment.commentId ?? index} className="flex gap-3">
                        <NoteAvatar name={comment.userName} src={comment.avatar} />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-muted-foreground">{comment.userName || "未知用户"}</p>
                          <p className="mt-1 whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground">{comment.content}</p>
                          <span className="mt-1 inline-flex items-center gap-1 text-xs tabular-nums text-muted-foreground"><Heart className="size-3" />{formatCount(comment.likes)}</span>
                          {comment.subComments?.length ? <CommentReplies replies={comment.subComments} /> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-sm text-muted-foreground">尚未采集评论明细</p>}
                {comments.length > 20 ? <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setShowAllComments(value => !value)}>{showAllComments ? "收起评论" : `展开全部 ${comments.length} 条主评论`}</Button> : null}
              </section>
            </div>
          </div>
          <footer className="shrink-0 border-t border-border/60 bg-white px-4 pb-3 pt-2 dark:bg-[#19191f]">
            <div className="mb-2 flex items-center justify-between gap-3 text-sm text-foreground">
              <span aria-label={`${note.likes} 个赞`} className="inline-flex items-center gap-1.5 tabular-nums"><Heart className="size-6" strokeWidth={1.5} />{formatCount(note.likes)}</span>
              <span aria-label={`${note.collects} 次收藏`} className="inline-flex items-center gap-1.5 tabular-nums"><Star className="size-6" strokeWidth={1.5} />{formatCount(note.collects)}</span>
              <button type="button" aria-label="查看已采评论" onClick={() => {
                const scroll = scrollRef.current;
                const section = commentsRef.current;
                if (scroll && section) scroll.scrollTop += section.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
              }} className="inline-flex min-h-9 items-center gap-1.5 rounded-lg px-1 tabular-nums outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring"><MessageCircle className="size-6" strokeWidth={1.5} />{formatCount(note.comments)}</button>
            </div>
            <div className="flex items-center gap-2">
            <Button size="sm" disabled={enqueue.isPending} onClick={() => enqueue.mutate()}><SendToBack className="size-3.5" />送入草稿</Button>
            {note.sourceUrl ? <ButtonLink variant="outline" size="sm" href={note.sourceUrl} target="_blank" rel="noreferrer"><ExternalLink className="size-3.5" />原笔记</ButtonLink> : null}
            <Button variant="ghost" size="sm" className={cn("ml-auto", confirmDelete ? "text-destructive" : "text-muted-foreground hover:text-destructive")} disabled={remove.isPending} onClick={() => confirmDelete ? remove.mutate() : setConfirmDelete(true)}><Trash2 className="size-3.5" />{confirmDelete ? "确认删除？" : "删除"}</Button>
            </div>
          </footer>
        </>
      )}
    </aside>
  );
}
