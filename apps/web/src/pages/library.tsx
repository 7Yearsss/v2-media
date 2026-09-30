import {
  Download,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  FolderOpen,
  Heart,
  ImageOff,
  LayoutGrid,
  List,
  Pencil,
  Plus,
  Search,
  SendToBack,
  Star,
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
import type { CollectedNote, NoteSortField, NoteSortDirection } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { InfiniteMasonry } from "@/components/motion/infinite-masonry";
import { Loader } from "@/components/motion/loader";
import {
  MorphingSearch,
  type MorphingSearchItem,
} from "@/components/motion/morphing-search";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { TiltCard } from "@/components/motion/tilt-card";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { LibraryNoteDetail } from "@/components/app/library-note-detail";
import { NoteAvatar } from "@/components/app/note-avatar";
import { LibraryNoteRow, NOTE_ROW_COLUMNS } from "@/components/app/library-note-row";
import { api, mediaUrl } from "@/lib/api";
import { formatCount } from "@/lib/format";
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
  selected,
}: {
  note: CollectedNote;
  onOpen: () => void;
  onEnqueue: () => void;
  enqueuing: boolean;
  selected: boolean;
}) {
  const cover = mediaUrl(note.cover || note.images[0]?.url);
  return (
    <TiltCard max={6} glare={false} className="h-full">
      <div
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn("group relative flex h-full cursor-pointer flex-col overflow-hidden rounded-2xl border bg-card text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", selected ? "border-primary ring-2 ring-primary/15" : "border-border hover:border-foreground/20")}
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
                <NoteAvatar name={note.authorName} src={note.authorAvatar} className="size-4 text-[9px]" />
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

export default function LibraryPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [keyword, setKeyword] = useState("");
  const [source, setSource] = useState("");
  const [collection, setCollection] = useState(""); // "" | "none" | id 字符串
  const [selected, setSelected] = useState<number | null>(null);
  const closeDetail = useCallback(() => setSelected(null), []);
  const [newColName, setNewColName] = useState("");
  const [showNewCol, setShowNewCol] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [sort, setSort] = useState<NoteSortField>("id");
  const [direction, setDirection] = useState<NoteSortDirection>("asc");
  const sortBy = (field: NoteSortField) => {
    setDirection(sort === field && direction === "desc" ? "asc" : "desc");
    setSort(field);
  };
  const [view, setView] = useState<"grid" | "list">(() => {
    try { return localStorage.getItem("v2media:library-view") === "list" ? "list" : "grid"; }
    catch { return "grid"; }
  });
  const changeView = (next: "grid" | "list") => {
    setView(next);
    try { localStorage.setItem("v2media:library-view", next); } catch { /* Storage can be unavailable. */ }
  };

  // 导出当前筛选为 CSV（Excel 双击直开）；文件名取库名方便归档
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await api.exportNotes({
        collectionId: collection || undefined,
        keyword: keyword || undefined,
        source: source || undefined,
      });
      const colName =
        collection === "none"
          ? "未分组"
          : collections.find((c) => String(c.id) === collection)?.name ?? "全部";
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `v2media-${colName}-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error("导出失败", e instanceof Error ? e.message : undefined);
    } finally {
      setExporting(false);
    }
  };

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
    queryKey: ["notes", keyword, source, collection, sort, direction],
    queryFn: ({ pageParam }) =>
      api.notes({ keyword, source, collectionId: collection || undefined, cursor: pageParam, sort, direction }),
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
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <div className={cn("min-h-0 min-w-0 flex-1 flex-col", selected !== null ? "hidden lg:flex" : "flex")}>
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

          <div className="flex flex-wrap items-center justify-between gap-3">
          <Tabs value={source} onValueChange={setSource} variant="pill">
            <TabsList>
              {SOURCE_TABS.map((t) => (
                <TabsTrigger key={t.value} value={t.value}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <div className="flex items-center gap-2">
          <select aria-label="笔记排序" value={`${sort}-${direction}`} onChange={event => {
            const [field, order] = event.target.value.split("-"); setSort(field as NoteSortField); setDirection(order as NoteSortDirection);
          }} className="h-9 max-w-40 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <option value="id-asc">默认顺序</option>
            {([{ field: "likes", label: "点赞" }, { field: "collects", label: "收藏" }, { field: "comments", label: "评论" }, { field: "savedAt", label: "采集时间" }, { field: "publishedAt", label: "原笔记发布" }] as const).flatMap(({field,label}) => [
              <option key={`${field}-desc`} value={`${field}-desc`}>{label}{field === "savedAt" || field === "publishedAt" ? "从新到旧" : "从高到低"}</option>,
              <option key={`${field}-asc`} value={`${field}-asc`}>{label}{field === "savedAt" || field === "publishedAt" ? "从旧到新" : "从低到高"}</option>,
            ])}
          </select>
          <div role="group" aria-label="内容库视图" className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
            {([{ value: "grid", label: "网格", icon: LayoutGrid }, { value: "list", label: "列表", icon: List }] as const).map(({ value, label, icon: Icon }) =>
              <button key={value} type="button" aria-pressed={view === value} onClick={() => changeView(value)} className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon className="size-3.5" />{label}</button>)}
          </div>
          </div>
          </div>

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
            <Button
              variant="outline"
              size="sm"
              className="ml-auto h-7 rounded-full px-3 text-xs"
              disabled={exporting || items.length === 0}
              onClick={() => void exportCsv()}
            >
              <Download className="size-3.5" />
              {exporting ? "导出中…" : "导出 Excel"}
            </Button>
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
            <div className={cn("flex h-full min-h-0 flex-col", view === "list" && "@container overflow-hidden rounded-xl border border-border bg-card")}>
            {view === "list" ? <div className={cn(NOTE_ROW_COLUMNS, "shrink-0 border-b border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground")}>
              <span>笔记</span><span className="hidden @[900px]:block">作者</span><div className="grid grid-cols-3 gap-2">{([{ field: "likes", label: "点赞" }, { field: "collects", label: "收藏" }, { field: "comments", label: "评论" }] as const).map(({field,label}) => {
                const Icon = sort === field ? direction === "desc" ? ArrowDown : ArrowUp : ArrowUpDown;
                return <button key={field} type="button" aria-label={`按${label}排序`} aria-pressed={sort === field} title={`点击按${label}${sort === field && direction === "desc" ? "从低到高" : "从高到低"}排序`} onClick={() => sortBy(field)} className={cn("inline-flex min-h-7 items-center justify-end gap-0.5 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", sort === field && "text-primary")} >{label}<Icon className="size-3 shrink-0" /></button>;
              })}</div>{([{ field: "savedAt", label: "采集时间" }, { field: "publishedAt", label: "原笔记发布" }] as const).map(({field,label}) => {
                const Icon = sort === field ? direction === "desc" ? ArrowDown : ArrowUp : ArrowUpDown;
                return <button key={field} type="button" aria-label={`按${label}排序`} aria-pressed={sort === field} onClick={() => sortBy(field)} title={`点击按${label}${sort === field && direction === "desc" ? "从旧到新" : "从新到旧"}排序`} className={cn("hidden min-h-7 items-center justify-end gap-0.5 rounded outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring @[900px]:inline-flex", sort === field && "text-primary")}>{label}<Icon className="size-3 shrink-0" /></button>;
              })}<span className="hidden @[900px]:block" />
            </div> : null}
            <InfiniteMasonry
              key={`${view}-${sort}-${direction}`}
              items={items}
              getItemKey={(n) => n.id}
              renderItem={(n) => view === "list" ? <LibraryNoteRow note={n} selected={selected === n.id} onOpen={() => setSelected(n.id)} onEnqueue={() => enqueue.mutate(n.id)} enqueuing={enqueue.isPending} /> : (
                <NoteCard
                  note={n}
                  selected={selected === n.id}
                  onOpen={() => setSelected(n.id)}
                  onEnqueue={() => enqueue.mutate(n.id)}
                  enqueuing={enqueue.isPending}
                />
              )}
              estimateSize={(n) => {
                if (view === "list") return 80;
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
              minColumnWidth={view === "list" ? 1 : 220}
              maxColumns={view === "list" ? 1 : 5}
              gap={view === "list" ? 0 : 14}
              animateItems={view !== "list"}
              ariaLabel={view === "list" ? "笔记列表" : "笔记瀑布流"}
              className={cn("min-h-0 flex-1", view === "list" && "rounded-none border-0 bg-card p-0")}
            />
            </div>
          )}
        </div>

      </div>
      {selected !== null ? (
        <LibraryNoteDetail key={selected} noteId={selected} onClose={closeDetail} />
      ) : null}
    </div>
  );
}
