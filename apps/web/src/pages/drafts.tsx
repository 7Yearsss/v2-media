import {
  AlertTriangle,
  FileText,
  Loader2,
  PenLine,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  applyAllBannedFixes,
  applyBannedFix,
  BANNED_KIND_META,
  checkBannedWords,
  checkDraftLimits,
  DRAFT_LIMITS,
  summarizeBanned,
  type NoteImage,
  type Draft,
} from "@v2media/shared";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import {
  SwipeableList,
  type SwipeableListItem,
} from "@/components/motion/swipeable-list";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { DraftImages } from "@/components/app/draft-images";
import { DraftCover } from "@/components/app/draft-cover";
import { DraftAccount } from "@/components/app/draft-account";
import { AiPanel } from "@/components/app/ai-panel";
import { RiskTextarea } from "@/components/app/risk-textarea";
import { XhsNotePreview } from "@/components/app/xhs-preview";
import { api, captureSession, isCurrentSession, mediaUrl } from "@/lib/api";
import { DraftEditSession, type DraftEditView, type DraftText } from "@/lib/draft-edit-session";
import { useBannedWords } from "@/lib/hooks/use-banned-words";
import { timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

export default function DraftsPage() {
  const navigate = useNavigate();
  const params = useParams<{ id?: string }>();
  const selectedId = params.id ? Number(params.id) : null;
  const toast = useToast();
  const queryClient = useQueryClient();
  const session = useMemo(() => captureSession(), []);
  const editor = useMemo(() => new DraftEditSession({
    userId: session.user!.id, writerId: crypto.randomUUID(), storage: localStorage,
    active: () => isCurrentSession(session), load: id => api.draft(id, session),
    save: async (id, patch) => {
      const saved = await api.updateDraft(id, patch, session);
      if (isCurrentSession(session)) {
        queryClient.setQueryData(["draft-media", id], saved);
        queryClient.setQueryData<Draft[]>(["drafts"], current => current?.map(d => d.id === id ? saved : d));
      }
      return saved;
    },
  }), [session, queryClient]);

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
  // 发布前自查：标题 + 正文里的违禁/限流词，边写边提示
  const { words: customWords, add: addWord, remove: removeWord } = useBannedWords();
  const bannedOpts = useMemo(() => ({ extraWords: customWords }), [customWords]);
  const banned = useMemo(() => summarizeBanned(checkBannedWords(`${title}\n${content}`, bannedOpts)), [title, content, bannedOpts]);
  const [showWords, setShowWords] = useState(false);
  const [riskOpen, setRiskOpen] = useState(false);
  // 正文里的命中（内联高亮用，位置相对正文）
  const contentHits = useMemo(() => checkBannedWords(content, bannedOpts), [content, bannedOpts]);
  // 只改这一处：弹层里点“改成…”
  const fixHit = (h: { index: number; word: string; suggest?: string }) => {
    if (h.suggest === undefined) return;
    update({ content: content.slice(0, h.index) + h.suggest + content.slice(h.index + h.word.length) });
  };
  const [wordInput, setWordInput] = useState("");
  const contentRef = useRef<HTMLTextAreaElement>(null);
  // 点词：在正文里选中第一处（标题里的看颜色就能找到）
  const locate = (word: string) => {
    const el = contentRef.current;
    const i = content.indexOf(word);
    if (!el || i < 0) return;
    el.focus();
    el.setSelectionRange(i, i + word.length);
  };
  const limits = useMemo(() => checkDraftLimits({ title, content, tags }), [title, content, tags]);
  const [images, setImages] = useState<NoteImage[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [editView, setEditView] = useState<DraftEditView | null>(null);
  const saveState = editView?.state ?? "saved";
  const savedAt = editView?.savedAt ? new Date(editView.savedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : null;
  const timerRef = useRef<number | undefined>(undefined);
  const editingIdRef = useRef<number | null>(null);
  const showEdit = useCallback((view: DraftEditView) => {
    setEditView(view); setTitle(view.fields.title); setContent(view.fields.content); setTags(view.fields.tags);
  }, []);

  // 切换草稿 → 先把上一个草稿未落盘的编辑立即保存，再装载字段
  useLayoutEffect(() => {
    window.clearTimeout(timerRef.current);
    const previousId = editingIdRef.current;
    if (previousId !== null && previousId !== selected?.id) void editor.flush(previousId);
    if (selected) {
      editingIdRef.current = selected.id;
      const view = editor.open(selected); showEdit(view);
      setImages(selected.images);
      if (view.state === "dirty") timerRef.current = window.setTimeout(() => { void editor.flush(selected.id); }, 900);
    } else {
      editingIdRef.current = null;
      setTitle("");
      setContent("");
      setTags([]);
      setImages([]);
      setEditView(null);
    }
    if (previousId !== selected?.id) setTagInput("");
  }, [selected, editor, showEdit]);

  useEffect(() => editor.subscribe(() => {
    const id = editingIdRef.current; const view = id === null ? null : editor.view(id);
    if (view) showEdit(view);
  }), [editor, showEdit]);

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

  const syncGeneratedDraft = (draft: Draft) => {
    if (editingIdRef.current !== draft.id) return;
    queryClient.setQueryData<Draft[]>(["drafts"], current => current?.map(d => d.id === draft.id ? draft : d));
    showEdit(editor.open(draft));
  };
  const beforeGenerate = async () => {
    const draftId = editingIdRef.current;
    if (draftId === null) return false;
    window.clearTimeout(timerRef.current);
    return isCurrentSession(session) && await editor.flush(draftId) && isCurrentSession(session);
  };

  /** 更新字段并触发防抖自动保存。 */
  const update = useCallback(
    (patch: Partial<DraftText>) => {
      const draftId = editingIdRef.current;
      if (draftId === null) return;
      showEdit(editor.change(draftId, patch));
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(() => {
        void editor.flush(draftId);
      }, 900);
    },
    [editor, showEdit],
  );

  useEffect(
    () => () => {
      window.clearTimeout(timerRef.current);
      const id = editingIdRef.current;
      if (id !== null) void editor.flush(id);
    },
    [editor],
  );

  const addTag = () => {
    const t = tagInput.trim().replace(/^#/, "");
    if (!t) return;
    if (!tags.includes(t)) update({ tags: [...tags, t] });
    setTagInput("");
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
      editor.forget(id);
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
            "relative flex w-full items-center gap-3 px-3 py-2.5 text-left outline-none",
            "transition-colors hover:bg-muted/40",
            // 外层已经是卡片，选中只用左侧竖条标记，别再套一层底色方块
            active && "before:absolute before:inset-y-2.5 before:left-0 before:w-[3px] before:rounded-full before:bg-primary",
          )}
        >
          <span className="relative grid size-9 shrink-0 place-items-center overflow-hidden rounded-xl bg-muted text-muted-foreground">
            <FileText className="size-4" />
            {d.images[0]?.url && (
              <img
                src={mediaUrl(d.images[0].url)}
                alt=""
                onError={(e) => (e.currentTarget.style.display = "none")}
                className="absolute inset-0 h-full w-full object-cover"
              />
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
                    <button type="button" className="text-destructive underline" onClick={() => {
                      void editor.flush(selected.id);
                    }}>保存失败，点击重试</button>
                  )}
                  {saveState === "conflict" && <span className="text-destructive">版本冲突，本地改动已保留</span>}
                </span>
              </div>
              {selected.status !== "published" ? (
                <Button
                  size="sm"
                  variant={selected.status === "ready" ? "secondary" : "outline"}
                  disabled={toggleReady.isPending || saveState !== "saved" || ["queued", "writing"].includes(selected.generationState) || ["queued", "processing"].includes(selected.coverState) || (selected.status !== "ready" && (!images.length || images.some(i => !i.url)))}
                  onClick={() => toggleReady.mutate()}
                >
                  {selected.status === "ready" ? "取消就绪" : "标记就绪"}
                </Button>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-8 py-6">
              {editView?.recovered && saveState !== "saved" && <p className="text-xs text-amber-600">已恢复本地编辑，保存成功前请保留这些改动。</p>}
              {editView?.error && <div role="alert" className="space-y-2 rounded-xl border border-amber-400/40 p-3 text-xs">
                <p>{editView.error}</p>
                {saveState === "conflict" && <>
                  {editView.server && <details><summary className="cursor-pointer">查看服务器最新版本</summary><pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap">{editView.server.title}{"\n\n"}{editView.server.content}{"\n"}{editView.server.tags.map(t => `#${t}`).join(" ")}</pre></details>}
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => { void editor.resolve(selected.id, "local"); }}>保留我的改动并保存</Button>
                    <Button size="sm" variant="outline" onClick={() => { void editor.resolve(selected.id, "server"); }}>使用服务器版本</Button>
                  </div>
                </>}
              </div>}
              <DraftAccount key={`account-${selected.id}`} draftId={selected.id} beforeChange={beforeGenerate} />
              <input
                value={title}
                onChange={(e) => update({ title: e.target.value })}
                placeholder="填写标题，最多 20 字"
                aria-label="标题"
                className="w-full bg-transparent px-1 text-2xl font-semibold leading-9 outline-none placeholder:text-muted-foreground/40"
              />

              <RiskTextarea
                value={content}
                onChange={(v) => update({ content: v })}
                hits={contentHits}
                onFix={fixHit}
                placeholder="写点什么…"
                ariaLabel="正文"
                textareaRef={contentRef}
              />

              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-3 text-[11px] text-muted-foreground">
                <span className={cn([...title].length > DRAFT_LIMITS.title && "font-medium text-rose-500")}>
                  标题 {[...title].length}/{DRAFT_LIMITS.title}
                </span>
                <span className={cn([...content].length > DRAFT_LIMITS.content && "font-medium text-rose-500")}>
                  正文 {[...content].length}/{DRAFT_LIMITS.content}
                </span>
                <button type="button" onClick={() => setShowWords((v) => !v)} className="transition-colors hover:text-primary">
                  我的屏蔽词{customWords.length ? ` · ${customWords.length}` : ""}
                </button>
                <button
                  type="button"
                  onClick={() => setRiskOpen((v) => !v)}
                  className={cn(
                    "ml-auto flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition-colors",
                    banned.length || limits.length
                      ? "bg-rose-500/10 text-rose-600 hover:bg-rose-500/15"
                      : "bg-emerald-500/10 text-emerald-600",
                  )}
                >
                  <i className={cn("size-1.5 rounded-full", banned.length || limits.length ? "bg-rose-500" : "bg-emerald-500")} />
                  {banned.length || limits.length ? `${banned.length + limits.length} 处需要看看` : "自查通过"}
                </button>
              </div>

              {showWords && (
                <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-muted/50 px-3.5 py-3 text-xs">
                  {customWords.map((w) => (
                    <span key={w} className="flex items-center gap-1 rounded-full bg-card px-2.5 py-1 ring-1 ring-border">
                      {w}
                      <button type="button" aria-label={`移除 ${w}`} onClick={() => removeWord(w)} className="text-muted-foreground hover:text-rose-500">
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                  <input
                    value={wordInput}
                    onChange={(e) => setWordInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && wordInput.trim()) {
                        e.preventDefault();
                        addWord(wordInput);
                        setWordInput("");
                      }
                    }}
                    maxLength={20}
                    placeholder="加一个要避开的词，回车"
                    className="min-w-32 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/60"
                  />
                </div>
              )}

              {riskOpen && (banned.length > 0 || limits.length > 0) && (
                <div className="divide-y divide-border/60 overflow-hidden rounded-2xl border border-border text-xs">
                  {limits.map((l) => (
                    <div key={l.field} className="flex items-center gap-2 px-3.5 py-2.5 font-medium text-rose-500">
                      <AlertTriangle className="size-3.5 shrink-0" />
                      {l.message}（{l.used}/{l.max}）
                    </div>
                  ))}
                  {banned.map((b) => (
                    <div key={b.word} className="flex items-center gap-2.5 px-3.5 py-2.5">
                      <i className={cn("size-2 shrink-0 rounded-full", b.severity === "high" ? "bg-rose-500" : "bg-amber-500")} />
                      <button type="button" onClick={() => locate(b.word)} title="在正文里选中" className="font-medium hover:text-primary">
                        {b.word}
                        {b.count > 1 && <span className="ml-1 font-normal text-muted-foreground">×{b.count}</span>}
                      </button>
                      <span className="text-muted-foreground">{BANNED_KIND_META[b.kind].label}</span>
                      {b.suggest !== undefined ? (
                        <button
                          type="button"
                          onClick={() =>
                            update({
                              title: applyBannedFix(title, b.word, b.suggest),
                              content: applyBannedFix(content, b.word, b.suggest),
                            })
                          }
                          className="ml-auto rounded-full bg-primary/10 px-2.5 py-1 font-medium text-primary transition-colors hover:bg-primary/20"
                        >
                          {b.suggest ? `改成「${b.suggest}」` : "删除"}
                        </button>
                      ) : (
                        <span className="ml-auto text-muted-foreground">需要换个说法</span>
                      )}
                    </div>
                  ))}
                  {banned.some((b) => b.suggest !== undefined) && (
                    <button
                      type="button"
                      onClick={() =>
                        update({
                          title: applyAllBannedFixes(title, bannedOpts),
                          content: applyAllBannedFixes(content, bannedOpts),
                        })
                      }
                      className="w-full bg-muted/40 px-3.5 py-2.5 text-center font-medium text-primary transition-colors hover:bg-muted"
                    >
                      一键处理能自动改的
                    </button>
                  )}
                </div>
              )}

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

              <DraftCover key={`cover-${selected.id}`} draftId={selected.id} beforeGenerate={beforeGenerate} />
              <DraftImages key={selected.id} draftId={selected.id} onDraftChange={syncGeneratedDraft} onImagesChange={(id, next) => {
                if (editingIdRef.current === id) setImages(next);
              }} />
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
