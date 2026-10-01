import {
  Download,
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  LayoutGrid,
  List,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { CollectedNote, NoteSortField, NoteSortDirection } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { CollectionTabs } from "@/components/app/collection-tabs";
import { useCollectionPrefs } from "@/lib/hooks/use-collection-prefs";
import { ConfirmDialog } from "@/components/app/confirm-dialog";
import { InfiniteMasonry } from "@/components/motion/infinite-masonry";
import { Loader } from "@/components/motion/loader";
import {
  MorphingSearch,
  type MorphingSearchItem,
} from "@/components/motion/morphing-search";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { LibraryNoteDetail } from "@/components/app/library-note-detail";
import { FilterSelect } from "@/components/app/filter-select";
import { LibraryBulkBar } from "@/components/app/library-bulk-bar";
import { LibraryFilterBar, rangeFilterActive } from "@/components/app/library-filter-bar";
import { LibraryStats, LibraryTopics } from "@/components/app/library-summary";
import { LibraryNoteCard } from "@/components/app/library-note-card";
import { LibraryNoteRow, NOTE_ROW_COLUMNS } from "@/components/app/library-note-row";
import { api, type NoteRangeFilter } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { hotThreshold } from "@/lib/note-insight";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";
import { useViewedNotes } from "@/lib/hooks/use-viewed-notes";

const SORT_OPTIONS = [
  { value: "id-asc", label: "默认顺序" },
  ...(
    [
      { field: "likes", label: "点赞" },
      { field: "collects", label: "收藏" },
      { field: "comments", label: "评论" },
      { field: "savedAt", label: "采集时间" },
      { field: "publishedAt", label: "原笔记发布" },
    ] as const
  ).flatMap(({ field, label }) => {
    const time = field === "savedAt" || field === "publishedAt";
    return [
      { value: `${field}-desc`, label: `${label}${time ? "从新到旧" : "从高到低"}` },
      { value: `${field}-asc`, label: `${label}${time ? "从旧到新" : "从低到高"}` },
    ];
  }),
];

const SOURCE_OPTIONS = [
  { value: "", label: "来源：全部" },
  { value: "search", label: "来源：搜索" },
  { value: "homefeed", label: "来源：首页推荐" },
  { value: "collect_page", label: "来源：收藏页" },
  { value: "like_page", label: "来源：点赞页" },
] as const;

const UNDO_MS = 5000;

export default function LibraryPage() {
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [keyword, setKeyword] = useState("");
  // 筛选 / 排序 / 当前打开的笔记都放进 URL：可分享、可刷新恢复、返回键能关闭详情
  const source = params.get("source") ?? "";
  const collection = params.get("col") ?? ""; // "" | "none" | id 字符串
  const tag = params.get("tag") ?? "";
  const sort = (params.get("sort") ?? "id") as NoteSortField;
  const direction = (params.get("dir") ?? "asc") as NoteSortDirection;
  const typeParam = params.get("type");
  const likesParam = Number(params.get("likes")) || undefined;
  const daysParam = Number(params.get("days")) || undefined;
  const authorParam = params.get("author") || undefined;
  const authorNameParam = params.get("authorName") || undefined;
  const range = useMemo<NoteRangeFilter>(
    () => ({
      type: typeParam === "video" || typeParam === "image" ? typeParam : undefined,
      minLikes: likesParam,
      withinDays: daysParam,
      authorId: authorParam,
      authorName: authorParam ? authorNameParam : undefined,
    }),
    [typeParam, likesParam, daysParam, authorParam, authorNameParam],
  );
  const selected = Number(params.get("note")) || null;
  const patch = useCallback(
    (changes: Record<string, string | undefined>, opts?: { push?: boolean }) =>
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const [k, v] of Object.entries(changes)) {
            if (v) next.set(k, v);
            else next.delete(k);
          }
          return next;
        },
        { replace: !opts?.push, state: opts?.push ? { fromList: true } : location.state },
      ),
    [setParams, location.state],
  );
  const setSource = (v: string) => patch({ source: v || undefined });
  const setCollection = (v: string) => patch({ col: v || undefined });
  const setTag = (v: string) => patch({ tag: v || undefined });
  const setRange = (r: NoteRangeFilter) =>
    patch({
      type: r.type || undefined,
      likes: r.minLikes ? String(r.minLikes) : undefined,
      days: r.withinDays ? String(r.withinDays) : undefined,
      author: r.authorId || undefined,
      authorName: r.authorId ? r.authorName || undefined : undefined,
    });
  // 详情里点话题 / 作者：回到列表并按它筛选（关闭详情，不入历史栈）
  const filterByTag = (t: string) => patch({ tag: t, note: undefined });
  const filterByAuthor = (id: string, name: string) => patch({ author: id, authorName: name || undefined, note: undefined });
  const setSortBy = (field: NoteSortField, dir: NoteSortDirection) =>
    patch({ sort: field === "id" ? undefined : field, dir: field === "id" ? undefined : dir });
  const openNote = useCallback((id: number) => patch({ note: String(id) }, { push: true }), [patch]);
  const closeDetail = useCallback(() => {
    if ((location.state as { fromList?: boolean } | null)?.fromList) navigate(-1);
    else patch({ note: undefined });
  }, [location.state, navigate, patch]);
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [renaming, setRenaming] = useState<{ id: number; name: string } | null>(null);
  const [deletingCol, setDeletingCol] = useState<{ id: number; name: string; noteCount: number } | null>(null);
  const [drafted, setDrafted] = useState<Set<number>>(() => new Set());
  const [hidden, setHidden] = useState<Set<number>>(() => new Set());
  const pendingDelete = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const viewed = useViewedNotes();
  const sortBy = (field: NoteSortField) => setSortBy(field, sort === field && direction === "desc" ? "asc" : "desc");
  const [view, setView] = useState<"grid" | "list">(() => {
    try { return localStorage.getItem("v2media:library-view") === "list" ? "list" : "grid"; }
    catch { return "grid"; }
  });
  const changeView = (next: "grid" | "list") => {
    setView(next);
    try { localStorage.setItem("v2media:library-view", next); } catch { /* Storage can be unavailable. */ }
  };

  const [exporting, setExporting] = useState(false);

  // 导出当前筛选为 CSV（Excel 双击直开）；文件名取库名方便归档
  const exportCsv = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const blob = await api.exportNotes({
        collectionId: collection || undefined,
        keyword: keyword || undefined,
        source: source || undefined,
        tag: tag || undefined,
        ...range,
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
    queryKey: ["notes", keyword, source, collection, sort, direction, range, tag],
    queryFn: ({ pageParam }) =>
      api.notes({ keyword, source, tag, collectionId: collection || undefined, cursor: pageParam, sort, direction, ...range }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
  });

  const summaryQuery = useQuery({
    queryKey: ["notes-summary", keyword, source, collection, range, tag],
    queryFn: () => api.notesSummary({ keyword, source, tag, collectionId: collection || undefined, ...range }),
    // 切筛选时沿用上一份数据，摘要条不闪没
    placeholderData: keepPreviousData,
  });
  // 选中话题后 summary 只剩该话题的共现标签；另取一份不带话题的，保证其它话题仍可切换
  const tagsQuery = useQuery({
    queryKey: ["notes-summary", keyword, source, collection, range, ""],
    queryFn: () => api.notesSummary({ keyword, source, collectionId: collection || undefined, ...range }),
    enabled: tag !== "",
    placeholderData: keepPreviousData,
  });
  const summary = summaryQuery.data
    ? { ...summaryQuery.data, topTags: (tag ? tagsQuery.data?.topTags : undefined) ?? summaryQuery.data.topTags }
    : undefined;
  const prefs = useCollectionPrefs();
  const pickCollection = (id: number) => {
    setCollection(String(id));
    prefs.touch(id);
  };

  const loaded = useMemo(
    () => notesQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [notesQuery.data],
  );
  // 撤销窗口内的笔记先从列表里藏起来，到点才真删
  const items = useMemo(() => (hidden.size ? loaded.filter((n) => !hidden.has(n.id)) : loaded), [loaded, hidden]);

  // 离开页面时把还在撤销窗口里的删除立刻落实，避免"看着删了其实没删"
  useEffect(() => {
    const timers = pendingDelete.current;
    return () => {
      for (const [id, t] of timers) {
        clearTimeout(t);
        void api.deleteNote(id);
      }
      timers.clear();
    };
  }, []);
  const deleteWithUndo = useCallback(
    (id: number, title: string) => {
      setHidden((h) => new Set(h).add(id));
      if (selected === id) closeDetail();
      const finish = () => {
        pendingDelete.current.delete(id);
        void api
          .deleteNote(id)
          .then(() => {
            void queryClient.invalidateQueries({ queryKey: ["notes"] });
            void queryClient.invalidateQueries({ queryKey: ["notes-summary"] });
            void queryClient.invalidateQueries({ queryKey: ["collections"] });
            void queryClient.invalidateQueries({ queryKey: ["overview"] });
          })
          .catch((e) => toast.error("删除失败", e instanceof Error ? e.message : undefined))
          .finally(() => setHidden((h) => { const n = new Set(h); n.delete(id); return n; }));
      };
      pendingDelete.current.set(id, setTimeout(finish, UNDO_MS));
      toast.toast({
        title: "已删除",
        description: title || "（无标题）",
        status: "success",
        action: {
          label: "撤销",
          onClick: () => {
            const t = pendingDelete.current.get(id);
            if (t === undefined) return;
            clearTimeout(t);
            pendingDelete.current.delete(id);
            setHidden((h) => { const n = new Set(h); n.delete(id); return n; });
          },
        },
      });
    },
    [selected, closeDetail, queryClient, toast],
  );

  // 打开过的笔记标记为已看
  useEffect(() => {
    if (selected !== null) viewed.mark(selected);
  }, [selected, viewed.mark]);
  const selectedIndex = selected === null ? -1 : items.findIndex((n) => n.id === selected);
  const goNeighbor = useCallback(
    (step: -1 | 1) => {
      const next = items[selectedIndex + step];
      if (next) patch({ note: String(next.id) });
    },
    [items, selectedIndex, patch],
  );
  const clearFilters = () => setParams(new URLSearchParams(), { replace: true });

  const hotAt = useMemo(() => hotThreshold(items), [items]);

  // 筛选/排序变了，可见列表就变了：清掉勾选，避免对看不见的笔记做批量操作
  useEffect(() => setChecked(new Set()), [keyword, source, collection, sort, direction, range, tag]);
  useEffect(() => {
    if (checked.size === 0) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key === "Escape" && !el?.closest("input, textarea, select")) setChecked(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [checked.size]);
  const lastChecked = useRef<number | null>(null);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // range=true（按住 Shift）：从上次勾选的那条到这条之间整段选中
  const toggleChecked = useCallback((id: number, range?: boolean) => {
    const anchor = lastChecked.current;
    lastChecked.current = id;
    setChecked((prev) => {
      const next = new Set(prev);
      const list = itemsRef.current;
      const from = anchor === null ? -1 : list.findIndex((n) => n.id === anchor);
      const to = list.findIndex((n) => n.id === id);
      if (range && from >= 0 && to >= 0) {
        const [a, b] = from < to ? [from, to] : [to, from];
        for (let i = a; i <= b; i++) next.add(list[i]!.id);
      } else if (!next.delete(id)) next.add(id);
      return next;
    });
  }, []);
  // 悬停卡片就提前取详情，点开几乎秒开
  const prefetchNote = useCallback(
    (id: number) => void queryClient.prefetchQuery({ queryKey: ["note", id], queryFn: () => api.note(id), staleTime: 60_000 }),
    [queryClient],
  );
  useEffect(() => {
    // 开着详情时顺带预取上一条 / 下一条
    if (selectedIndex < 0) return;
    for (const n of [items[selectedIndex - 1], items[selectedIndex + 1]]) if (n) prefetchNote(n.id);
  }, [selectedIndex, items, prefetchNote]);
  // 拖拽到采集库标签：被拖的是已勾选的就带上全部勾选项，否则只移这一条
  const dragIds = (id: number) => (checked.has(id) ? [...checked] : [id]);
  const moveNotes = async (noteIds: number[], collectionId: number | null) => {
    try {
      const { affected } = await api.batchNotes({ action: "move", ids: noteIds, collectionId });
      const name = collectionId === null ? "未分组" : collections.find((c) => c.id === collectionId)?.name ?? "目标库";
      toast.success(`已移入「${name}」`, `${affected} 条笔记`);
      afterBulk();
    } catch (e) {
      toast.error("移入库失败", e instanceof Error ? e.message : undefined);
    }
  };

  const ids = () => [...checked];
  const afterBulk = () => {
    setChecked(new Set());
    void queryClient.invalidateQueries({ queryKey: ["notes"] });
    void queryClient.invalidateQueries({ queryKey: ["notes-summary"] });
    void queryClient.invalidateQueries({ queryKey: ["collections"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  };
  const runBulk = async (label: string, job: () => Promise<void>) => {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      await job();
    } catch (e) {
      toast.error(`${label}失败`, e instanceof Error ? e.message : undefined);
    } finally {
      setBulkBusy(false);
    }
  };
  const bulkMove = (collectionId: number | null) =>
    runBulk("移入库", async () => {
      const { affected } = await api.batchNotes({ action: "move", ids: ids(), collectionId });
      toast.success(`已${collectionId === null ? "移出库" : "移入库"}`, `${affected} 条笔记`);
      afterBulk();
    });
  const submitRename = () => {
    const name = renaming?.name.trim();
    const col = collections.find((c) => c.id === renaming?.id);
    if (renaming && name && col && name !== col.name) renameCol.mutate({ id: renaming.id, name });
    setRenaming(null);
  };
  const bulkDelete = () => {
    setConfirmBulkDelete(false);
    return runBulk("删除", async () => {
      const list = ids();
      const { affected } = await api.batchNotes({ action: "delete", ids: list });
      if (selected !== null && list.includes(selected)) closeDetail();
      toast.success("已删除", `${affected} 条笔记`);
      afterBulk();
    });
  };
  const bulkDraft = () =>
    runBulk("送入草稿", async () => {
      let ok = 0;
      for (const id of ids()) {
        try {
          await api.createDraft({ collectedNoteId: id });
          ok++;
        } catch { /* 逐条统计，单条失败不中断其余 */ }
      }
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      const failed = checked.size - ok;
      toast.toast({
        title: failed ? `已送入 ${ok} 条草稿，${failed} 条失败` : `已送入草稿工坊 ${ok} 条`,
        status: failed ? "error" : "success",
        action: { label: "打开", onClick: () => navigate("/drafts") },
      });
      if (ok > 0) {
        setDrafted((d) => new Set([...d, ...ids()]));
        setChecked(new Set());
      }
    });
  const bulkExport = () =>
    runBulk("导出", async () => {
      const blob = await api.exportNotes({ ids: ids() });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `v2media-已选${checked.size}条-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

  const enqueue = useMutation({
    mutationFn: (noteId: number) =>
      api.createDraft({ collectedNoteId: noteId }),
    onSuccess: (draft, noteId) => {
      setDrafted((d) => new Set(d).add(noteId));
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
        onSelect: () => openNote(n.id),
      })),
    [items, openNote],
  );

  return (
    <div className="relative flex h-full min-h-0 overflow-hidden">
      <div className={cn("relative min-h-0 min-w-0 flex-1 flex-col", selected !== null ? "hidden lg:flex" : "flex")}>
        <div className="shrink-0 space-y-4 px-6 pt-6">
          <div className="flex flex-wrap items-center gap-3">
            <div>
              <h2 className="text-xl font-semibold tracking-tight text-foreground">
                内容库
              </h2>
              <p className="mt-0.5 text-sm text-muted-foreground">
                插件采集的笔记素材，共 {summary?.notes ?? items.length} 条
                {notesQuery.hasNextPage ? `（已加载 ${items.length}，滚动加载更多）` : ""}
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

          <LibraryFilterBar
            value={range}
            onChange={setRange}
            lead={
              <FilterSelect
                value={source}
                onChange={setSource}
                options={SOURCE_OPTIONS}
                className="w-36"
              />
            }
            trail={
              <>
                {summary ? <LibraryTopics summary={summary} activeTag={tag} onTag={setTag} /> : null}
                <FilterSelect
                  value={`${sort}-${direction}`}
                  onChange={(v) => {
                    const [field, order] = v.split("-");
                    setSortBy(field as NoteSortField, order as NoteSortDirection);
                  }}
                  options={SORT_OPTIONS}
                  className="w-36"
                  panelClassName="right-0 left-auto w-44"
                />
                <div role="group" aria-label="内容库视图" className="inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-border bg-muted/40 p-0.5">
                  {([{ value: "grid", label: "网格", icon: LayoutGrid }, { value: "list", label: "列表", icon: List }] as const).map(({ value, label, icon: Icon }) =>
                    <button key={value} type="button" aria-pressed={view === value} onClick={() => changeView(value)} className={cn("inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring", view === value ? "bg-background text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground")}><Icon className="size-3.5" />{label}</button>)}
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 rounded-lg px-2.5 text-xs"
                  disabled={exporting || items.length === 0}
                  onClick={() => void exportCsv()}
                  title="导出当前筛选结果为 CSV（Excel 可直接打开）"
                >
                  <Download className="size-3.5" />
                  {exporting ? "导出中…" : "导出"}
                </Button>
              </>
            }
          />
          {/* 采集库标签栏 + 当前范围统计，合并成一行 */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
            <CollectionTabs
              onDropNotes={(noteIds, collectionId) => void moveNotes(noteIds, collectionId)}
              collections={collections}
              value={collection}
              onChange={setCollection}
              pinned={prefs.pinned}
              recent={prefs.recent}
              creating={createCol.isPending}
              onPick={pickCollection}
              onTogglePin={prefs.togglePin}
              onRename={(c) => setRenaming({ id: c.id, name: c.name })}
              onDelete={(c) => setDeletingCol({ id: c.id, name: c.name, noteCount: c.noteCount })}
              onCreate={(name) => createCol.mutate(name)}
            />
            {summary ? <LibraryStats summary={summary} /> : null}
          </div>
        </div>

        <div className={cn("min-h-0 flex-1 px-6 pb-6 pt-3", checked.size > 0 && "pb-24")}>
          {notesQuery.isPending ? (
            <div aria-busy="true" aria-label="加载内容库…" className="grid h-full grid-cols-[repeat(auto-fill,minmax(220px,1fr))] content-start gap-3.5 overflow-hidden">
              {Array.from({ length: 10 }, (_, i) => (
                <div key={i} className="animate-pulse overflow-hidden rounded-2xl border border-border bg-card">
                  <div className="aspect-[4/3] bg-muted" />
                  <div className="space-y-2 p-3"><div className="h-3 w-4/5 rounded-full bg-muted" /><div className="h-2 w-1/2 rounded-full bg-muted" /></div>
                </div>
              ))}
            </div>
          ) : notesQuery.isError ? (
            <PageError
              error={notesQuery.error}
              onRetry={notesQuery.refetch}
              className="h-full"
            />
          ) : items.length === 0 ? (
            <EmptyState
              title={keyword || tag || rangeFilterActive(range) ? "没有匹配的笔记" : "内容库还是空的"}
              description={
                keyword || tag || rangeFilterActive(range)
                  ? "换个关键词或放宽筛选条件试试"
                  : "安装并授权浏览器插件后，在小红书页面浏览即可自动采集"
              }
              action={
                keyword || tag || source || collection || rangeFilterActive(range) ? (
                  <Button variant="outline" size="sm" onClick={clearFilters}>清除筛选</Button>
                ) : undefined
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
              renderItem={(n, i) => {
                const props = {
                  note: n,
                  selected: selected === n.id,
                  checked: checked.has(n.id),
                  selecting: checked.size > 0,
                  onToggle: (range?: boolean) => toggleChecked(n.id, range),
                  onOpen: () => openNote(n.id),
                  onHover: () => prefetchNote(n.id),
                  index: i,
                  dragIds: () => dragIds(n.id),
                  onEnqueue: () => enqueue.mutate(n.id),
                  enqueuing: enqueue.isPending,
                  drafted: drafted.has(n.id),
                  viewed: viewed.has(n.id),
                  hotAt,
                };
                return view === "list" ? <LibraryNoteRow {...props} /> : <LibraryNoteCard {...props} />;
              }}
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

        {checked.size > 0 ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-5 z-20 flex justify-center px-6">
            <LibraryBulkBar
              count={checked.size}
              totalShown={items.length}
              total={summary?.notes}
              collections={collections}
              busy={bulkBusy}
              onSelectAll={() => setChecked(new Set(items.map((n) => n.id)))}
              onClear={() => setChecked(new Set())}
              onMove={(id) => void bulkMove(id)}
              onDraft={() => void bulkDraft()}
              onExport={() => void bulkExport()}
              onDelete={() => void bulkDelete()}
            />
          </div>
        ) : null}
      </div>
      {selected !== null ? (
        <LibraryNoteDetail
          noteId={selected}
          onClose={closeDetail}
          onTag={filterByTag}
          onAuthor={filterByAuthor}
          onPrev={selectedIndex > 0 ? () => goNeighbor(-1) : undefined}
          onNext={selectedIndex >= 0 && selectedIndex < items.length - 1 ? () => goNeighbor(1) : undefined}
          onDelete={deleteWithUndo}
        />
      ) : null}
      <ConfirmDialog
        open={confirmBulkDelete}
        onOpenChange={setConfirmBulkDelete}
        title={`删除选中的 ${checked.size} 条笔记？`}
        description="此操作不可恢复。"
        confirmLabel="删除"
        destructive
        onConfirm={bulkDelete}
      />
      <ConfirmDialog
        open={deletingCol !== null}
        onOpenChange={(o) => !o && setDeletingCol(null)}
        title={`删除库「${deletingCol?.name ?? ""}」？`}
        description={`其中 ${deletingCol?.noteCount ?? 0} 条笔记会回到未分组。`}
        confirmLabel="删除"
        destructive
        onConfirm={() => {
          if (deletingCol) deleteCol.mutate(deletingCol.id);
          setDeletingCol(null);
        }}
      />
      <ConfirmDialog
        open={renaming !== null}
        onOpenChange={(o) => !o && setRenaming(null)}
        title="重命名库"
        confirmLabel="保存"
        confirmDisabled={!renaming?.name.trim()}
        onConfirm={submitRename}
      >
        <Input
          autoFocus
          value={renaming?.name ?? ""}
          onChange={(name) => setRenaming((r) => (r ? { ...r, name } : r))}
          onKeyDown={(e) => {
            if (e.key === "Enter" && renaming?.name.trim()) submitRename();
          }}
          maxLength={32}
          aria-label="库名"
          classNames={{ field: "h-10" }}
        />
      </ConfirmDialog>
    </div>
  );
}
