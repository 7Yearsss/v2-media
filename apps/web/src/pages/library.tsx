import {
  ExternalLink,
  FolderOpen,
  Heart,
  ImageOff,
  MessageCircle,
  Pencil,
  Plus,
  Search,
  SendToBack,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CollectedNote } from "@v2media/shared";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button, ButtonLink } from "@/components/motion/button";
import { Drawer } from "@/components/motion/drawer";
import { InfiniteMasonry } from "@/components/motion/infinite-masonry";
import { Loader } from "@/components/motion/loader";
import {
  MorphingSearch,
  type MorphingSearchItem,
} from "@/components/motion/morphing-search";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { TiltCard } from "@/components/motion/tilt-card";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { api, mediaUrl, noteComments, type NoteDetail } from "@/lib/api";
import { formatCount, SOURCE_LABEL, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";

const SOURCE_TABS = [
  { value: "", label: "全部" },
  { value: "search", label: "搜索" },
  { value: "homefeed", label: "首页" },
  { value: "collect_page", label: "收藏" },
  { value: "like_page", label: "点赞" },
] as const;

function NoteCard({
  note,
  onOpen,
  onEnqueue,
  enqueuing,
}: {
  note: CollectedNote;
  onOpen: () => void;
  onEnqueue: () => void;
  enqueuing: boolean;
}) {
  const cover = mediaUrl(note.cover || note.images[0]?.url);
  return (
    <TiltCard max={6} glare={false} className="h-full">
      <div
        role="button"
        tabIndex={0}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter") onOpen();
        }}
        className="group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border border-border bg-card text-left outline-none transition-colors hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring"
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
          {note.type === "video" ? (
            <span className="absolute left-2 top-2 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-medium text-white">
              视频
            </span>
          ) : null}
          <div className="absolute inset-x-0 bottom-0 flex justify-end bg-gradient-to-t from-black/45 to-transparent p-2 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
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
        </div>
        <div className="flex flex-1 flex-col gap-2 p-3">
          <p className="line-clamp-2 text-sm font-medium leading-5 text-foreground">
            {note.title || "（无标题）"}
          </p>
          <div className="mt-auto flex items-center gap-1.5">
            {note.authorName ? (
              <>
                <span className="grid size-4 place-items-center rounded-full bg-muted text-[9px] text-muted-foreground">
                  {note.authorName.slice(0, 1)}
                </span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {note.authorName}
                </span>
              </>
            ) : (
              <span className="min-w-0 flex-1" />
            )}
            <span className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
              <Heart className="size-3" />
              {formatCount(note.likes)}
            </span>
            <span className="inline-flex items-center gap-0.5 text-[11px] tabular-nums text-muted-foreground">
              <Star className="size-3" />
              {formatCount(note.collects)}
            </span>
          </div>
        </div>
      </div>
    </TiltCard>
  );
}

function NoteDetailDrawer({
  noteId,
  onClose,
}: {
  noteId: number | null;
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const detail = useQuery({
    queryKey: ["note", noteId],
    queryFn: () => api.note(noteId!),
    enabled: noteId !== null,
  });

  const enqueue = useMutation({
    mutationFn: () => api.createDraft({ collectedNoteId: noteId! }),
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      toast.success("已送入草稿工坊", draft.title || "未命名草稿");
      onClose();
      navigate(`/drafts/${draft.id}`);
    },
    onError: (err) =>
      toast.error("送入草稿失败", err instanceof Error ? err.message : undefined),
  });

  const remove = useMutation({
    mutationFn: () => api.deleteNote(noteId!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      void queryClient.invalidateQueries({ queryKey: ["collections"] }); // 库计数跟着变
      toast.success("已从内容库删除");
      onClose();
    },
    onError: (err) =>
      toast.error("删除失败", err instanceof Error ? err.message : undefined),
  });

  const note: NoteDetail | undefined = detail.data;
  const comments = noteComments(note);

  return (
    <Drawer
      open={noteId !== null}
      onOpenChange={(open) => {
        if (!open) {
          setConfirmDelete(false);
          onClose();
        }
      }}
      side="right"
      ariaLabel="笔记详情"
      className="w-full max-w-xl"
    >
      <div className="flex h-full flex-col">
        {detail.isPending ? (
          <PageLoading label="加载笔记详情…" className="flex-1" />
        ) : detail.isError || !note ? (
          <PageError
            error={detail.error}
            onRetry={detail.refetch}
            className="flex-1"
          />
        ) : (
          <>
            <div className="flex-1 overflow-y-auto">
              {note.images.length > 0 ? (
                <div
                  className={cn(
                    "grid gap-1 bg-muted",
                    note.images.length === 1
                      ? "grid-cols-1"
                      : "grid-cols-2",
                  )}
                >
                  {note.images.slice(0, 6).map((img, i) => (
                    <img
                      key={`${img.url}-${i}`}
                      src={mediaUrl(img.url)}
                      alt={`图 ${i + 1}`}
                      loading="lazy"
                      className="aspect-square w-full object-cover"
                    />
                  ))}
                </div>
              ) : mediaUrl(note.cover) ? (
                <img
                  src={mediaUrl(note.cover)}
                  alt={note.title}
                  className="w-full object-cover"
                />
              ) : null}

              <div className="space-y-5 p-6">
                <div>
                  <h2 className="text-lg font-semibold leading-7 text-foreground">
                    {note.title || "（无标题）"}
                  </h2>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{note.authorName || "未知作者"}</span>
                    <span>·</span>
                    <span>{timeAgo(note.savedAt)} 采集</span>
                    <AnimatedBadge size="sm" status="neutral">
                      {SOURCE_LABEL[note.source] ?? note.source}
                    </AnimatedBadge>
                  </div>
                </div>

                <div className="flex items-center gap-4 rounded-2xl border border-border bg-muted/40 px-4 py-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Heart className="size-3.5" /> {formatCount(note.likes)}
                  </span>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <Star className="size-3.5" /> {formatCount(note.collects)}
                  </span>
                  <span className="inline-flex items-center gap-1 tabular-nums">
                    <MessageCircle className="size-3.5" />{" "}
                    {formatCount(note.comments)}
                  </span>
                </div>

                {note.content ? (
                  <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                    {note.content}
                  </p>
                ) : null}

                {note.tags.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {note.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
                      >
                        #{tag}
                      </span>
                    ))}
                  </div>
                ) : null}

                {comments.length > 0 ? (
                  <div>
                    <p className="mb-2 text-xs font-medium text-muted-foreground">
                      评论（{comments.length}）
                    </p>
                    <ul className="space-y-3">
                      {comments.slice(0, 20).map((c, i) => (
                        <li key={c.commentId ?? i} className="flex gap-2.5">
                          <span className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-full bg-muted text-[10px] text-muted-foreground">
                            {(c.userName || "?").slice(0, 1)}
                          </span>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground">
                              {c.userName}
                              <span className="ml-2 font-normal tabular-nums text-muted-foreground">
                                {formatCount(c.likes)} 赞
                              </span>
                            </p>
                            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                              {c.content}
                            </p>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2 border-t border-border bg-card p-4">
              <Button
                size="sm"
                disabled={enqueue.isPending}
                onClick={() => enqueue.mutate()}
              >
                <SendToBack className="size-3.5" />
                送入草稿
              </Button>
              {note.sourceUrl ? (
                <ButtonLink
                  variant="outline"
                  size="sm"
                  href={note.sourceUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink className="size-3.5" />
                  原笔记
                </ButtonLink>
              ) : null}
              <div className="ml-auto">
                {confirmDelete ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="border-destructive/40 text-destructive hover:bg-destructive/10"
                    disabled={remove.isPending}
                    onClick={() => remove.mutate()}
                  >
                    <Trash2 className="size-3.5" />
                    确认删除？
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted-foreground hover:text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="size-3.5" />
                    删除
                  </Button>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </Drawer>
  );
}

export default function LibraryPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [source, setSource] = useState("");
  const [collection, setCollection] = useState(""); // "" | "none" | id 字符串
  const [selected, setSelected] = useState<number | null>(null);
  const [newColName, setNewColName] = useState("");
  const [showNewCol, setShowNewCol] = useState(false);

  const collectionsQuery = useQuery({
    queryKey: ["collections"],
    queryFn: () => api.collections(),
  });
  const collections = collectionsQuery.data?.items ?? [];

  const createCol = useMutation({
    mutationFn: (name: string) => api.createCollection(name),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      setNewColName("");
      setShowNewCol(false);
    },
    onError: (err) =>
      toast.error("新建库失败", err instanceof Error ? err.message : undefined),
  });
  const renameCol = useMutation({
    mutationFn: ({ id, name }: { id: number; name: string }) =>
      api.renameCollection(id, name),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ["collections"] }),
    onError: (err) =>
      toast.error("改名失败", err instanceof Error ? err.message : undefined),
  });
  const deleteCol = useMutation({
    mutationFn: (id: number) => api.deleteCollection(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["collections"] });
      void queryClient.invalidateQueries({ queryKey: ["notes"] });
      setCollection("");
      toast.success("库已删除，笔记回到总池");
    },
    onError: (err) =>
      toast.error("删除库失败", err instanceof Error ? err.message : undefined),
  });

  const notesQuery = useInfiniteQuery({
    queryKey: ["notes", keyword, source, collection],
    queryFn: ({ pageParam }) =>
      api.notes({ keyword, source, collectionId: collection || undefined, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  const items = useMemo(
    () => notesQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [notesQuery.data],
  );

  const enqueue = useMutation({
    mutationFn: (noteId: number) =>
      api.createDraft({ collectedNoteId: noteId }),
    onSuccess: (draft) => {
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      toast.toast({
        title: "已送入草稿工坊",
        description: draft.title || "未命名草稿",
        status: "success",
        action: {
          label: "打开",
          onClick: () => navigate(`/drafts/${draft.id}`),
        },
      });
    },
    onError: (err) =>
      toast.error("送入草稿失败", err instanceof Error ? err.message : undefined),
  });

  const searchItems = useMemo<MorphingSearchItem[]>(
    () =>
      items.slice(0, 8).map((n) => ({
        id: `note-${n.id}`,
        title: n.title || "（无标题）",
        description: `${n.authorName || "未知作者"} · ${formatCount(n.likes)} 赞`,
        icon: Search,
        onSelect: () => setSelected(n.id),
      })),
    [items],
  );

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 space-y-4 px-6 pt-6">
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              内容库
            </h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              插件采集的笔记素材，{items.length}
              {notesQuery.hasNextPage ? "+" : ""} 条
            </p>
          </div>
          <div className="ml-auto">
            <MorphingSearch
              items={searchItems}
              placeholder="搜索标题 / 作者…"
              shortcut=""
              onQueryChange={setKeyword}
              emptyMessage="没有匹配的笔记"
            />
          </div>
        </div>

        <Tabs value={source} onValueChange={setSource} variant="pill">
          <TabsList>
            {SOURCE_TABS.map((t) => (
              <TabsTrigger key={t.value} value={t.value}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {/* 采集库筛选：插件「当前采集库」把一批笔记归组 */}
        <div className="flex flex-wrap items-center gap-2">
          <FolderOpen className="size-4 text-muted-foreground" />
          {(
            [
              { v: "", label: "全部" },
              { v: "none", label: "未分组" },
            ] as const
          ).map((t) => (
            <button
              key={t.v}
              onClick={() => setCollection(t.v)}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                collection === t.v
                  ? "bg-primary text-primary-foreground"
                  : "bg-muted text-muted-foreground hover:bg-muted/70",
              )}
            >
              {t.label}
            </button>
          ))}
          {collections.map((col) => (
            <span key={col.id} className="inline-flex items-center">
              <button
                onClick={() => setCollection(String(col.id))}
                className={cn(
                  "rounded-full px-3 py-1 text-xs transition-colors",
                  collection === String(col.id)
                    ? "bg-primary text-primary-foreground"
                    : "bg-muted text-muted-foreground hover:bg-muted/70",
                )}
              >
                {col.name}
                <span className="ml-1 tabular-nums opacity-70">{col.noteCount}</span>
              </button>
              {collection === String(col.id) ? (
                <>
                  <button
                    title="改名"
                    className="ml-1 text-muted-foreground hover:text-foreground"
                    onClick={() => {
                      const name = window.prompt("库名", col.name)?.trim();
                      if (name && name !== col.name)
                        renameCol.mutate({ id: col.id, name });
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </button>
                  <button
                    title="删除库（笔记回到未分组）"
                    className="ml-0.5 text-muted-foreground hover:text-destructive"
                    onClick={() => {
                      if (window.confirm(`删除库「${col.name}」？其中 ${col.noteCount} 条笔记会回到未分组`))
                        deleteCol.mutate(col.id);
                    }}
                  >
                    <X className="size-3.5" />
                  </button>
                </>
              ) : null}
            </span>
          ))}
          {showNewCol ? (
            <span className="inline-flex items-center gap-1">
              <input
                autoFocus
                value={newColName}
                onChange={(e) => setNewColName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && newColName.trim())
                    createCol.mutate(newColName.trim());
                  if (e.key === "Escape") setShowNewCol(false);
                }}
                placeholder="库名，如 健身"
                maxLength={32}
                className="h-7 w-28 rounded-full border border-border bg-background px-3 text-xs outline-none focus:ring-1 focus:ring-ring"
              />
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-full px-3 text-xs"
                disabled={!newColName.trim() || createCol.isPending}
                onClick={() => createCol.mutate(newColName.trim())}
              >
                新建
              </Button>
            </span>
          ) : (
            <button
              onClick={() => setShowNewCol(true)}
              className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-foreground/30 hover:text-foreground"
            >
              <Plus className="size-3" />
              新建库
            </button>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 px-6 pb-6 pt-4">
        {notesQuery.isPending ? (
          <PageLoading label="加载内容库…" className="h-full" />
        ) : notesQuery.isError ? (
          <PageError
            error={notesQuery.error}
            onRetry={notesQuery.refetch}
            className="h-full"
          />
        ) : items.length === 0 ? (
          <EmptyState
            title={keyword ? "没有匹配的笔记" : "内容库还是空的"}
            description={
              keyword
                ? "换个关键词试试"
                : "安装并授权浏览器插件后，在小红书页面浏览即可自动采集"
            }
            className="h-full"
          />
        ) : (
          <InfiniteMasonry
            items={items}
            getItemKey={(n) => n.id}
            renderItem={(n) => (
              <NoteCard
                note={n}
                onOpen={() => setSelected(n.id)}
                onEnqueue={() => enqueue.mutate(n.id)}
                enqueuing={enqueue.isPending}
              />
            )}
            estimateSize={(n) => {
              const img = n.images[0];
              const ratio =
                img?.width && img?.height ? img.height / img.width : 0.75;
              return Math.min(420, 220 * Math.max(0.5, Math.min(ratio, 1.6))) + 96;
            }}
            onLoadMore={async () => {
              if (notesQuery.hasNextPage && !notesQuery.isFetchingNextPage)
                await notesQuery.fetchNextPage();
            }}
            hasMore={Boolean(notesQuery.hasNextPage)}
            loading={notesQuery.isFetchingNextPage}
            renderLoadingItem={(i) => (
              <div
                key={i}
                className="flex h-40 items-center justify-center rounded-2xl border border-border bg-card"
              >
                <Loader variant="dots" size={20} label="加载更多" />
              </div>
            )}
            emptyState={
              <EmptyState
                title="没有匹配的笔记"
                description="换个关键词或来源试试"
              />
            }
            endState={
              <p className="py-6 text-center text-xs text-muted-foreground">
                — 到底啦 —
              </p>
            }
            minColumnWidth={220}
            maxColumns={5}
            gap={14}
            ariaLabel="笔记瀑布流"
            className="h-full"
          />
        )}
      </div>

      <NoteDetailDrawer
        noteId={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}
