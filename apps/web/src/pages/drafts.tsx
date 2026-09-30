import {
  FileText,
  ImagePlus,
  Loader2,
  PenLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NoteImage } from "@v2media/shared";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  SwipeableList,
  type SwipeableListItem,
} from "@/components/motion/swipeable-list";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { AiPanel } from "@/components/app/ai-panel";
import { XhsNotePreview } from "@/components/app/xhs-preview";
import { api, mediaUrl } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type SaveState = "saved" | "dirty" | "saving" | "error";

export default function DraftsPage() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const selectedId = params.id ? Number(params.id) : null;
  const toast = useToast();
  const queryClient = useQueryClient();

  const draftsQuery = useQuery({ queryKey: ["drafts"], queryFn: api.drafts });
  const drafts = useMemo(() => draftsQuery.data ?? [], [draftsQuery.data]);
  const selected = useMemo(
    () => drafts.find((d) => d.id === selectedId) ?? null,
    [drafts, selectedId],
  );

  // ---- 编辑器本地态（提升到页面层，让右侧预览实时刷新） ----
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [images, setImages] = useState<NoteImage[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [imageInput, setImageInput] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const editingIdRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<{
    draftId: number;
    fields: { title: string; content: string; tags: string[]; images: NoteImage[] };
  } | null>(null);

  // 切换草稿 → 先把上一个草稿未落盘的编辑立即保存，再装载字段
  useEffect(() => {
    window.clearTimeout(timerRef.current);
    const pending = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (pending) void persist(pending.draftId, pending.fields);
    if (selected) {
      editingIdRef.current = selected.id;
      setTitle(selected.title);
      setContent(selected.content);
      setTags(selected.tags);
      setImages(selected.images);
      setSaveState("saved");
      setSavedAt(null);
    } else {
      editingIdRef.current = null;
      setTitle("");
      setContent("");
      setTags([]);
      setImages([]);
      setSaveState("saved");
    }
    setTagInput("");
    setImageInput("");
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // 路由无 id 时自动选第一篇
  useEffect(() => {
    if (selectedId === null && drafts.length > 0) {
      navigate(`/drafts/${drafts[0]!.id}`, { replace: true });
    }
  }, [selectedId, drafts, navigate]);

  const invalidate = useCallback(
    () => void queryClient.invalidateQueries({ queryKey: ["drafts"] }),
    [queryClient],
  );

  const persist = useCallback(
    async (draftId: number, next: {
      title: string;
      content: string;
      tags: string[];
      images: NoteImage[];
    }) => {
      setSaveState("saving");
      try {
        await api.updateDraft(draftId, {
          title: next.title,
          content: next.content,
          tags: next.tags,
          images: next.images.map((i) => ({ url: i.url })),
        });
        if (editingIdRef.current === draftId) {
          setSaveState("saved");
          setSavedAt(
            new Date().toLocaleTimeString("zh-CN", {
              hour: "2-digit",
              minute: "2-digit",
            }),
          );
        }
        invalidate();
      } catch {
        if (editingIdRef.current === draftId) setSaveState("error");
      }
    },
    [invalidate],
  );

  /** 更新字段并触发防抖自动保存。 */
  const update = useCallback(
    (patch: Partial<{
      title: string;
      content: string;
      tags: string[];
      images: NoteImage[];
    }>) => {
      const draftId = editingIdRef.current;
      if (draftId === null) return;
      setTitle((cur) => patch.title ?? cur);
      setContent((cur) => patch.content ?? cur);
      setTags((cur) => patch.tags ?? cur);
      setImages((cur) => patch.images ?? cur);
      setSaveState("dirty");
      window.clearTimeout(timerRef.current);
      const fields = {
        title: patch.title ?? title,
        content: patch.content ?? content,
        tags: patch.tags ?? tags,
        images: patch.images ?? images,
      };
      pendingSaveRef.current = { draftId, fields }; // 切换草稿时立即落盘
      timerRef.current = window.setTimeout(() => {
        pendingSaveRef.current = null;
        void persist(draftId, fields);
      }, 900);
    },
    [content, images, persist, tags, title],
  );

  useEffect(
    () => () => window.clearTimeout(timerRef.current),
    [],
  );

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "");
    if (!t) return;
    if (!tags.includes(t)) update({ tags: [...tags, t] });
    setTagInput("");
  };

  const addImage = () => {
    const u = imageInput.trim();
    if (!u) return;
    update({ images: [...images, { url: u }] });
    setImageInput("");
  };

  const create = useMutation({
    mutationFn: () => api.createDraft({ title: "", content: "" }),
    onSuccess: (draft) => {
      invalidate();
      navigate(`/drafts/${draft.id}`);
    },
    onError: (err) =>
      toast.error("创建失败", err instanceof Error ? err.message : undefined),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.deleteDraft(id),
    onSuccess: (_v, id) => {
      invalidate();
      toast.success("草稿已删除");
      if (selectedId === id) navigate("/drafts", { replace: true });
    },
    onError: (err) =>
      toast.error("删除失败", err instanceof Error ? err.message : undefined),
  });

  const toggleReady = useMutation({
    mutationFn: () =>
      api.updateDraft(selected!.id, {
        status: selected!.status === "ready" ? "draft" : "ready",
      }),
    onSuccess: () => {
      invalidate();
      toast.success(
        selected?.status === "ready" ? "已标记为草稿" : "已标记为就绪",
      );
    },
    onError: (err) =>
      toast.error(
        "更新状态失败",
        err instanceof Error ? err.message : undefined,
      ),
  });

  const listItems = useMemo<SwipeableListItem[]>(
    () =>
      drafts.map((d) => ({
        id: String(d.id),
        rightActions: [
          {
            id: "delete",
            label: "删除",
            icon: <Trash2 className="h-4 w-4" />,
            tone: "danger" as const,
          },
        ],
      })),
    [drafts],
  );

  const renderItem = useCallback(
    (item: SwipeableListItem) => {
      const d = drafts.find((x) => String(x.id) === item.id);
      if (!d) return null;
      const active = d.id === selectedId;
      return (
        <button
          type="button"
          onClick={() => navigate(`/drafts/${d.id}`)}
          className={cn(
            "flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none",
            "transition-colors",
            active ? "bg-muted" : "hover:bg-muted/60",
          )}
        >
          <span className="grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl border border-border bg-background text-muted-foreground">
            {d.images[0]?.url ? (
              <img
                src={mediaUrl(d.images[0].url)}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <FileText className="size-4" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-sm",
                active ? "font-semibold" : "font-medium",
                "text-foreground",
              )}
            >
              {d.title || "未命名草稿"}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              {d.content ? d.content.slice(0, 40) : "（空正文）"}
            </span>
          </span>
          <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
            {timeAgo(d.updatedAt)}
          </span>
        </button>
      );
    },
    [drafts, selectedId, navigate],
  );

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[280px_minmax(0,1fr)_380px]">
      {/* 左栏：草稿队列（滑动删除） */}
      <aside className="flex min-h-0 flex-col border-b border-border lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <p className="text-sm font-semibold text-foreground">草稿队列</p>
          <Button
            size="sm"
            variant="ghost"
            disabled={create.isPending}
            onClick={() => create.mutate()}
          >
            <Plus className="size-4" />
            新建
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {draftsQuery.isPending ? (
            <PageLoading label="加载草稿…" />
          ) : draftsQuery.isError ? (
            <PageError error={draftsQuery.error} onRetry={draftsQuery.refetch} />
          ) : drafts.length === 0 ? (
            <EmptyState
              icon={PenLine}
              title="还没有草稿"
              description="从内容库把笔记送入草稿，或直接新建空白草稿"
              action={
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => create.mutate()}
                >
                  <Plus className="size-3.5" />
                  新建草稿
                </Button>
              }
              className="py-10"
            />
          ) : (
            <SwipeableList
              items={listItems}
              renderItem={renderItem}
              onAction={({ item, action }) => {
                if (action.id === "delete") remove.mutate(Number(item.id));
              }}
              actionWidth={64}
              classNames={{ item: "overflow-hidden rounded-xl" }}
            />
          )}
        </div>
      </aside>

      {/* 中栏：编辑器 */}
      <section className="flex min-h-0 min-w-0 flex-col border-b border-border bg-background lg:border-b-0 lg:border-r">
        {selected ? (
          <>
            <div className="flex items-center justify-between border-b border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <AnimatedBadge
                  size="sm"
                  status={
                    selected.status === "ready"
                      ? "success"
                      : selected.status === "published"
                        ? "info"
                        : "neutral"
                  }
                >
                  {selected.status === "ready"
                    ? "就绪"
                    : selected.status === "published"
                      ? "已发布"
                      : "草稿"}
                </AnimatedBadge>
                <span className="text-xs text-muted-foreground">
                  {saveState === "saving" && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 className="size-3 animate-spin" /> 保存中…
                    </span>
                  )}
                  {saveState === "saved" &&
                    (savedAt
                      ? `已保存 ${savedAt}`
                      : `更新于 ${timeAgo(selected.updatedAt)}`)}
                  {saveState === "dirty" && "未保存更改"}
                  {saveState === "error" && (
                    <span className="text-destructive">保存失败，重试中</span>
                  )}
                </span>
              </div>
              {selected.status !== "published" ? (
                <Button
                  size="sm"
                  variant={selected.status === "ready" ? "secondary" : "outline"}
                  disabled={toggleReady.isPending}
                  onClick={() => toggleReady.mutate()}
                >
                  {selected.status === "ready" ? "取消就绪" : "标记就绪"}
                </Button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-5">
              <Input
                placeholder="笔记标题…"
                value={title}
                onChange={(v) => update({ title: v })}
                aria-label="标题"
                classNames={{ input: "text-base font-semibold" }}
              />

              <textarea
                value={content}
                onChange={(e) => update({ content: e.target.value })}
                placeholder="正文内容…"
                aria-label="正文"
                rows={14}
                className={cn(
                  "w-full resize-y rounded-xl border border-input bg-card px-3.5 py-3",
                  "text-sm leading-6 text-foreground outline-none transition-colors",
                  "placeholder:text-muted-foreground/70 focus:border-ring",
                )}
              />

              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  话题标签
                </p>
                <div className="flex flex-wrap items-center gap-1.5">
                  {tags.map((t) => (
                    <span
                      key={t}
                      className="group inline-flex items-center gap-1 rounded-full bg-primary/10 py-1 pl-2.5 pr-1.5 text-xs text-primary"
                    >
                      #{t}
                      <button
                        type="button"
                        aria-label={`删除标签 ${t}`}
                        onClick={() =>
                          update({ tags: tags.filter((x) => x !== t) })
                        }
                        className="grid size-3.5 place-items-center rounded-full opacity-0 transition-opacity hover:bg-primary/20 group-hover:opacity-100"
                      >
                        <X className="size-2.5" />
                      </button>
                    </span>
                  ))}
                  <Input
                    value={tagInput}
                    onChange={setTagInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag();
                      }
                    }}
                    placeholder="+ 加标签"
                    className="w-28"
                    classNames={{ field: "h-7 border-dashed", input: "pl-2.5 pr-2.5 text-xs" }}
                  />
                </div>
              </div>

              <div>
                <p className="mb-2 text-xs font-medium text-muted-foreground">
                  图片（{images.length}）
                </p>
                <div className="grid grid-cols-3 gap-2">
                  {images.map((img, i) => (
                    <div
                      key={`${img.url}-${i}`}
                      className="group relative aspect-square overflow-hidden rounded-xl border border-border bg-muted"
                    >
                      <img
                        src={mediaUrl(img.url)}
                        alt={`图 ${i + 1}`}
                        loading="lazy"
                        className="h-full w-full object-cover"
                      />
                      <button
                        type="button"
                        aria-label={`删除图 ${i + 1}`}
                        onClick={() =>
                          update({ images: images.filter((_, x) => x !== i) })
                        }
                        className="absolute right-1.5 top-1.5 grid size-6 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100"
                      >
                        <X className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
                {/* TODO(契约缺口)：服务端暂无图片上传接口，先用 URL 添加；契约补
                    POST /api/media 后换成 motion/file-upload 组件 */}
                <div className="mt-2 flex gap-2">
                  <Input
                    value={imageInput}
                    onChange={setImageInput}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addImage();
                      }
                    }}
                    placeholder="粘贴图片 URL 添加…"
                    className="flex-1"
                    classNames={{ field: "h-8", input: "pl-3 pr-3 text-xs" }}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={addImage}
                    disabled={!imageInput.trim()}
                  >
                    <ImagePlus className="size-3.5" />
                    添加
                  </Button>
                </div>
              </div>
            </div>
          </>
        ) : (
          <EmptyState
            icon={PenLine}
            title="选择左侧草稿开始编辑"
            description="或新建一篇空白草稿"
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => create.mutate()}
              >
                <Plus className="size-3.5" />
                新建草稿
              </Button>
            }
            className="flex-1"
          />
        )}
      </section>

      {/* 右栏：小红书卡片实时预览 + AI 助手 */}
      <aside className="min-h-0 overflow-y-auto bg-muted/30 p-4">
        <div className="space-y-4">
          <div>
            <p className="mb-2 text-xs font-medium text-muted-foreground">
              小红书卡片预览
            </p>
            <XhsNotePreview
              title={title}
              content={content}
              tags={tags}
              images={images}
            />
          </div>
          <AiPanel
            draft={selected}
            title={title}
            content={content}
            onApplyRewrite={(t, c) => update({ title: t, content: c })}
            onApplyTitle={(t) => update({ title: t })}
            onApplyTags={(ts) =>
              update({ tags: Array.from(new Set([...tags, ...ts])) })
            }
          />
        </div>
      </aside>
    </div>
  );
}
