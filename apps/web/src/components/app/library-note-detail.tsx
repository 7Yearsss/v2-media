import { Check, ChevronDown, ChevronLeft, ChevronUp, Copy, ExternalLink, FileText, Heart, MessageCircle, MoreHorizontal, Pencil, SendToBack, Star, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/motion/button";
import { PageError } from "@/components/app/states";
import { api, mediaUrl, noteComments } from "@/lib/api";
import { formatBytes, formatCount, formatDuration, timeAgo } from "@/lib/format";
import { commentDate, xhsEmoji } from "@/lib/xhs-text";
import { cn } from "@/lib/utils";
import { EASE_OUT } from "@/lib/ease";
import { useToast } from "@/lib/toast";
import { NoteImageGallery } from "./note-image-gallery";
import { NoteVideoPlayer } from "./note-video-player";
import { ImageLightbox } from "./image-lightbox";
import { NoteAvatar } from "./note-avatar";
import type { NoteComment } from "@v2media/shared";

/** 一条评论（主评论与回复共用）：昵称 + 作者标记、正文、图片、日期属地、点赞。 */
function CommentItem({ comment, authorId, small, onOpenImages }: { comment: NoteComment; authorId: string; small?: boolean; onOpenImages: (urls: string[], index: number) => void }) {
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
              <button key={`${url}-${i}`} type="button" aria-label={`放大查看评论图片 ${i + 1}`} onClick={() => onOpenImages(comment.pictures!.map((p) => mediaUrl(p)), i)} className="block cursor-zoom-in overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <img src={mediaUrl(url)} alt="评论图片" loading="lazy" decoding="async" className="size-24 object-cover transition-transform duration-200 hover:scale-105" />
              </button>
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

function CommentReplies({ replies, total, authorId, onOpenImages }: { replies: NoteComment[]; total?: number; authorId: string; onOpenImages: (urls: string[], index: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const missing = total && total > replies.length ? total - replies.length : 0;
  return (
    <div className="mt-2">
      {expanded ? (
        <ul className="space-y-4 py-2">
          {replies.map((reply, index) => (
            <li key={reply.commentId ?? index}><CommentItem comment={reply} authorId={authorId} small onOpenImages={onOpenImages} /></li>
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

/** 加载中的占位：长得像手机上的一篇笔记（大图 + 标题 + 几行正文 + 评论），比转圈更不突兀。 */
function DetailSkeleton() {
  return (
    <div aria-busy="true" aria-label="加载笔记详情…" className="min-h-0 flex-1 animate-pulse overflow-hidden px-3 pt-3">
      <div className="aspect-[3/4] w-full rounded-2xl bg-muted" />
      <div className="space-y-3 px-1 pt-5">
        <div className="h-5 w-3/4 rounded-full bg-muted" />
        <div className="h-3 w-full rounded-full bg-muted" />
        <div className="h-3 w-11/12 rounded-full bg-muted" />
        <div className="h-3 w-2/3 rounded-full bg-muted" />
      </div>
      <div className="mt-8 space-y-4 border-t border-border px-1 pt-5">
        {[0, 1].map((i) => (
          <div key={i} className="flex gap-2.5">
            <div className="size-9 shrink-0 rounded-full bg-muted" />
            <div className="flex-1 space-y-2"><div className="h-3 w-1/4 rounded-full bg-muted" /><div className="h-3 w-5/6 rounded-full bg-muted" /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 顶栏右侧「⋯」：复制文案 / 复制链接 / 原笔记 / 删除。 */
function NoteMenu({ sourceUrl, onCopyText, onDelete }: { sourceUrl?: string; onCopyText: () => void; onDelete: () => void }) {
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
  const item = "flex w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-sm outline-none transition-colors hover:bg-muted focus-visible:bg-muted";
  return (
    <div ref={rootRef} className="relative">
      <button type="button" aria-label="更多操作" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} className="grid size-9 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <MoreHorizontal className="size-5" />
      </button>
      {open ? (
        <div role="menu" className="absolute right-0 top-full z-30 mt-1 w-48 rounded-2xl border border-border bg-background p-1.5 shadow-lg">
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onCopyText(); }} className={item}><FileText className="size-4" />复制文案</button>
          {sourceUrl ? (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); void navigator.clipboard?.writeText(sourceUrl); }} className={item}><Copy className="size-4" />复制原笔记链接</button>
          ) : null}
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
export function LibraryNoteDetail({
  noteId,
  onClose,
  onPrev,
  onNext,
  onDelete,
  onTag,
  onAuthor,
}: {
  noteId: number;
  /** 点正文里的 #话题：回列表并按它筛选。 */
  onTag?: (tag: string) => void;
  /** 点作者：回列表只看这个作者。 */
  onAuthor?: (authorId: string, authorName: string) => void;
  onClose: () => void;
  /** 列表里的上一条 / 下一条；没有就不传。 */
  onPrev?: () => void;
  onNext?: () => void;
  /** 删除交给列表页处理（带 5 秒撤销）。 */
  onDelete: (id: number, title: string) => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const panelRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const commentsRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [showAllComments, setShowAllComments] = useState(false);
  const [sortMode, setSortMode] = useState<"default" | "hot" | "new">("default");
  const [expanded, setExpanded] = useState(false);
  const [lightbox, setLightbox] = useState<{ images: string[]; index: number } | null>(null);
  const openImages = (images: string[], index: number) => setLightbox({ images, index });
  // 面板一直挂着、只换笔记（不再整块重建）：状态在这里重置，并回到顶部
  useEffect(() => {
    setShowAllComments(false);
    setSortMode("default");
    setExpanded(false);
    setLightbox(null);
    scrollRef.current?.scrollTo({ top: 0 });
  }, [noteId]);
  const navRef = useRef({ prev: onPrev, next: onNext });
  navRef.current = { prev: onPrev, next: onNext };
  const detail = useQuery({ queryKey: ["note", noteId], queryFn: () => api.note(noteId), staleTime: 30_000 });

  useEffect(() => {
    const previousFocus = document.activeElement;
    const panel = panelRef.current;
    closeRef.current?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) onClose();
      const typing = (event.target as HTMLElement | null)?.closest("input, textarea, select, [contenteditable]");
      if (typing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "j") navRef.current.next?.();
      if (event.key === "k") navRef.current.prev?.();
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
  const note = detail.data;
  const copyText = async () => {
    if (!note) return;
    const text = [note.title, note.content, note.tags.map((t) => `#${t}`).join(" ")].filter(Boolean).join("\n\n");
    try {
      await navigator.clipboard.writeText(text);
      toast.success("已复制文案", `${text.length} 字`);
    } catch {
      toast.error("复制失败", "浏览器未授权剪贴板");
    }
  };
  const images = note?.images.length ? note.images : note?.cover ? [{ url: note.cover }] : [];
  const isVideo = note?.type === "video" && Boolean(note.videoUrl);
  const comments = noteComments(note);
  // 作者本人的评论始终置顶，其余按所选方式排（排序稳定，「默认」保持采集顺序）
  const sortedComments = useMemo(() => {
    const authorId = note?.authorId;
    const isAuthor = (c: NoteComment) => c.isAuthor || (Boolean(authorId) && c.userId === authorId);
    const base = [...comments];
    if (sortMode === "hot") base.sort((a, b) => b.likes - a.likes);
    else if (sortMode === "new") base.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
    return [...base.filter(isAuthor), ...base.filter((c) => !isAuthor(c))];
  }, [comments, sortMode, note?.authorId]);
  const longContent = Boolean(note?.content) && ((note?.content.length ?? 0) > 160 || (note?.content.split("\n").length ?? 0) > 6);
  const replies = comments.reduce((count, comment) => count + (comment.subComments?.length ?? 0), 0);

  return (
    <aside ref={panelRef} aria-label="笔记详情" className="relative flex h-full min-h-0 w-full flex-col overflow-hidden bg-muted/40 lg:w-[492px] lg:shrink-0 lg:bg-transparent lg:py-3 lg:pl-1 lg:pr-4">
      {/* 手机画布：内容固定在约 390px 宽的列里，看到的就是手机上的排布 */}
      <motion.div
        initial={reduceMotion ? false : { opacity: 0, x: 28 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: 0.3, ease: EASE_OUT }}
        className="mx-auto flex h-full min-h-0 w-full max-w-[420px] flex-col overflow-hidden bg-white dark:bg-[#19191f] lg:rounded-[28px] lg:border lg:border-border/70 lg:shadow-[0_8px_32px_-8px_rgba(0,0,0,0.18)]">
      <header className="flex shrink-0 items-center gap-2.5 border-b border-border/50 px-3 py-3">
        <h2 className="sr-only">笔记详情</h2>
        <button ref={closeRef} type="button" onClick={onClose} aria-label="关闭笔记详情" title="关闭（Esc）" className="grid size-9 shrink-0 place-items-center rounded-xl text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
          {/* 窄屏详情铺满整个页面，用返回箭头；桌面端是侧边弹出的面板，用关闭 × */}
          <ChevronLeft className="size-5 lg:hidden" />
          <X className="hidden size-5 lg:block" />
        </button>
        <NoteAvatar name={note?.authorName || ""} src={note?.authorAvatar} className="size-9 text-sm" />
        <div className="min-w-0 flex-1">
          {note?.authorId && onAuthor ? (
            <button type="button" onClick={() => onAuthor(note.authorId, note.authorName)} title="只看这个作者的笔记" className="block max-w-full truncate rounded text-left text-[15px] font-medium text-foreground outline-none hover:text-primary focus-visible:ring-2 focus-visible:ring-ring">{note.authorName || "未知作者"}</button>
          ) : (
            <p className="truncate text-[15px] font-medium text-foreground">{note?.authorName || "笔记详情"}</p>
          )}
          <p className="mt-0.5 flex items-center gap-1 text-[11px] text-muted-foreground">
            {note ? <>{timeAgo(note.savedAt)}采集<Check className="size-3 text-emerald-500" />已入库</> : "正在加载"}
          </p>
        </div>
        {note ? (
          <>
            <span className="hidden items-center sm:inline-flex">
              <button type="button" aria-label="上一条" title="上一条（K）" disabled={!onPrev} onClick={onPrev} className="grid size-8 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><ChevronUp className="size-4" /></button>
              <button type="button" aria-label="下一条" title="下一条（J）" disabled={!onNext} onClick={onNext} className="grid size-8 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-30"><ChevronDown className="size-4" /></button>
            </span>
            <Button size="sm" disabled={enqueue.isPending} onClick={() => enqueue.mutate()}><SendToBack className="size-3.5" />送入草稿</Button>
            <NoteMenu sourceUrl={note.sourceUrl} onCopyText={() => void copyText()} onDelete={() => onDelete(noteId, note.title)} />
          </>
        ) : null}
      </header>
      {detail.isPending ? <DetailSkeleton /> : detail.isError || !note ? (
        <PageError error={detail.error} onRetry={detail.refetch} className="min-h-0 flex-1" />
      ) : (
        <>
          <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto overscroll-contain [scrollbar-width:none] lg:[scrollbar-width:thin]" aria-label="笔记详情内容">
            <motion.div key={noteId} initial={reduceMotion ? false : { opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: EASE_OUT }}>
            <div className="px-3 pt-3">
            {isVideo ? (
              <NoteVideoPlayer
                key={note.videoUrl}
                className="rounded-2xl"
                src={mediaUrl(note.videoUrl)}
                poster={mediaUrl(note.cover) || undefined}
                width={note.video?.width}
                height={note.video?.height}
                durationMs={note.video?.durationMs}
              />
            ) : images.length ? <NoteImageGallery images={images} /> : null}
            </div>
            {note.type === "video" && note.video ? (
              <p className="px-4 pt-2 text-[11px] tabular-nums text-muted-foreground" title="视频信息（采集时的所选清晰度）">
                {[
                  note.video.durationMs ? formatDuration(note.video.durationMs) : "",
                  note.video.width && note.video.height ? `${note.video.width}×${note.video.height}` : "",
                  note.video.fps ? `${note.video.fps}fps` : "",
                  note.video.size ? formatBytes(note.video.size) : "",
                  note.video.format?.toUpperCase() ?? "",
                ].filter(Boolean).join(" · ")}
              </p>
            ) : null}
            {note.type === "video" && !note.videoUrl ? (
              <p className="px-4 pt-2 text-xs text-amber-600 dark:text-amber-400">未采到播放地址</p>
            ) : null}
            <div className="space-y-6 px-4 pb-8 pt-4">
              <section aria-label="笔记正文" className="space-y-3">
                <h3 className="break-words text-lg font-semibold leading-7 text-foreground">{note.title || "（无标题）"}</h3>
                {note.content ? (
                  <div>
                    <p className={cn("whitespace-pre-wrap break-words text-[15px] leading-7 text-foreground", longContent && !expanded && "line-clamp-6")}>{xhsEmoji(note.content)}</p>
                    {longContent ? <button type="button" aria-expanded={expanded} onClick={() => setExpanded(v => !v)} className="mt-1 rounded text-sm text-primary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">{expanded ? "收起" : "展开全文"}</button> : null}
                  </div>
                ) : <p className="text-sm text-muted-foreground">暂未采集到正文</p>}
                {note.tags.length ? <div className="flex flex-wrap gap-x-2 gap-y-0.5">{note.tags.map(tag => onTag
                  ? <button key={tag} type="button" onClick={() => onTag(tag)} title={`按 #${tag} 筛选内容库`} className="rounded text-[15px] leading-7 text-sky-700 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring dark:text-sky-300">#{tag}</button>
                  : <span key={tag} className="text-[15px] leading-7 text-sky-700 dark:text-sky-300">#{tag}</span>)}</div> : null}
                {(note.publishedAt || note.ipLocation) ? <p className="pt-1 text-xs text-muted-foreground">{note.publishedAt ? new Date(note.publishedAt).toLocaleDateString("zh-CN") : ""}{note.ipLocation ? ` ${note.ipLocation}` : ""}</p> : null}
              </section>
              <section ref={commentsRef} aria-label="笔记评论" className="border-t border-border pt-5">
                <div className="flex items-center justify-between gap-2">
                  <h4 className="text-sm font-semibold text-foreground">共 {formatCount(note.comments)} 条评论</h4>
                  {comments.length > 1 ? (
                    <div role="group" aria-label="评论排序" className="inline-flex items-center gap-0.5 rounded-full bg-muted p-0.5">
                      {([["default", "默认"], ["hot", "最热"], ["new", "最新"]] as const).map(([value, label]) => (
                        <button key={value} type="button" aria-pressed={sortMode === value} onClick={() => setSortMode(value)} className={cn("h-6 rounded-full px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", sortMode === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}>{label}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">已采 {comments.length} 条主评论{replies ? `、${replies} 条回复` : ""} · 平台显示 {formatCount(note.comments)} 条评论</p>
                {comments.length ? (
                  <ul className="mt-5 space-y-6">
                    {(showAllComments ? sortedComments : sortedComments.slice(0, 20)).map((comment, index) => (
                      <li key={comment.commentId ?? index}>
                        <CommentItem comment={comment} authorId={note.authorId} onOpenImages={openImages} />
                        {comment.subComments?.length || comment.subCommentCount ? (
                          <div className="pl-[46px]">
                            <CommentReplies replies={comment.subComments ?? []} total={comment.subCommentCount} authorId={note.authorId} onOpenImages={openImages} />
                          </div>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className="mt-3 text-sm text-muted-foreground">尚未采集评论明细</p>}
                {comments.length > 20 ? <Button variant="ghost" size="sm" className="mt-2 w-full" onClick={() => setShowAllComments(value => !value)}>{showAllComments ? "收起评论" : `展开全部 ${comments.length} 条主评论`}</Button> : null}
              </section>
            </div>
            </motion.div>
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
      </motion.div>
      <ImageLightbox
        images={lightbox?.images ?? null}
        index={lightbox?.index ?? 0}
        onIndexChange={(index) => setLightbox((l) => (l ? { ...l, index } : l))}
        onClose={() => setLightbox(null)}
      />
    </aside>
  );
}
