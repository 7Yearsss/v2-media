import {
  Archive,
  CalendarClock,
  Lightbulb,
  Loader2,
  NotebookPen,
  Plus,
  Sparkles,
  Target,
  Trash2,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Collection, HostedAccount, Topic, TopicStatus } from "@v2media/shared";
import { AnimatedBadge, type AnimatedBadgeStatus } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Drawer } from "@/components/motion/drawer";
import { Input } from "@/components/motion/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { api } from "@/lib/api";
import { fmtDateTime, timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

type TopicRow = Topic;

const STATUS_META: Record<TopicStatus, { label: string; badge: AnimatedBadgeStatus }> = {
  idea: { label: "想法", badge: "neutral" },
  planned: { label: "已排期", badge: "info" },
  drafted: { label: "已转草稿", badge: "info" },
  published: { label: "已发布", badge: "success" },
  archived: { label: "已归档", badge: "neutral" },
};

const STATUS_TABS: Array<{ value: string; label: string }> = [
  { value: "", label: "全部" },
  { value: "idea", label: "想法" },
  { value: "planned", label: "已排期" },
  { value: "drafted", label: "已转草稿" },
  { value: "published", label: "已发布" },
  { value: "archived", label: "已归档" },
];

const SOURCE_LABEL: Record<Topic["sourceType"], string> = {
  manual: "手填",
  collection: "采集库",
  note: "笔记",
  ai: "AI 生成",
};

const DIM_LABEL: Record<string, string> = {
  traffic: "流量潜力",
  fit: "账号匹配",
  diff: "竞争差异",
  monetization: "变现潜力",
  evergreen: "时效价值",
  cost: "制作成本↓",
  risk: "合规安全↑",
};

function scoreTone(score?: number): string {
  if (score == null) return "text-muted-foreground";
  if (score >= 70) return "text-emerald-500";
  if (score >= 50) return "text-amber-500";
  return "text-rose-500";
}

function scoreLabel(score?: number): string {
  if (score == null) return "未评分";
  if (score >= 70) return "做";
  if (score >= 50) return "改方向";
  return "不做";
}

/** 新建选题抽屉。 */
function NewTopicDrawer({
  open,
  onOpenChange,
  collections,
  accounts,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  collections: Collection[];
  accounts: HostedAccount[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const [title, setTitle] = useState("");
  const [angle, setAngle] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [plannedAt, setPlannedAt] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      const planned = plannedAt ? new Date(plannedAt).getTime() : undefined;
      await api.createTopic({
        title: title.trim(),
        angle: angle.trim() || undefined,
        collectionId: collectionId ? Number(collectionId) : undefined,
        accountId: accountId ? Number(accountId) : undefined,
        plannedAt: planned && Number.isFinite(planned) ? planned : undefined,
      });
      toast.success("选题已加入选题池");
      onCreated();
      onOpenChange(false);
      setTitle("");
      setAngle("");
      setCollectionId("");
      setAccountId("");
      setPlannedAt("");
    } catch (err) {
      toast.error("创建失败", err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} side="right" ariaLabel="新建选题" className="w-full max-w-md">
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">新建选题</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            记下一个内容方向，后续可深评、排期、转草稿
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">选题标题</p>
            <Input value={title} onChange={setTitle} placeholder="例：新手露营装备避坑清单" />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">切入角度（可选）</p>
            <textarea
              value={angle}
              onChange={(e) => setAngle(e.target.value)}
              rows={4}
              placeholder="从哪个角度写、覆盖哪些要点…"
              className="w-full resize-none rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none focus:border-primary/50"
            />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">来源采集库（可选）</p>
            <Select value={collectionId} onValueChange={setCollectionId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="不关联" />
              </SelectTrigger>
              <SelectContent>
                {collections.map((cl) => (
                  <SelectItem key={cl.id} value={String(cl.id)}>
                    {cl.name}（{cl.noteCount}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">目标账号（可选）</p>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="不指定" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.nickname || `账号 #${a.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">计划发布时间（可选）</p>
            <Input type="datetime-local" value={plannedAt} onChange={setPlannedAt} />
          </div>
        </div>
        <div className="border-t border-border p-4">
          <Button className="w-full" disabled={!title.trim() || submitting} onClick={submit}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
            加入选题池
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/** AI 生成抽屉：选采集库 → 出 N 个带评分的选题。 */
function AiTopicsDrawer({
  open,
  onOpenChange,
  collections,
  accounts,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  collections: Collection[];
  accounts: HostedAccount[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const [collectionId, setCollectionId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [count, setCount] = useState(5);
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!collectionId || submitting) return;
    setSubmitting(true);
    try {
      const res = await api.aiTopics({
        collectionId: Number(collectionId),
        count,
        accountId: accountId ? Number(accountId) : undefined,
      });
      toast.success(`已生成 ${res.items.length} 个选题`, "已按七维口径评分入池");
      onCreated();
      onOpenChange(false);
    } catch (err) {
      toast.error("生成失败", err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer open={open} onOpenChange={onOpenChange} side="right" ariaLabel="AI 生成选题" className="w-full max-w-md">
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">AI 生成选题</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            分析采集库里的爆款笔记，沿同赛道换角度产出新选题，并做七维评分
          </p>
        </div>
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">基于哪个采集库</p>
            <Select value={collectionId} onValueChange={setCollectionId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择采集库…" />
              </SelectTrigger>
              <SelectContent>
                {collections.map((cl) => (
                  <SelectItem key={cl.id} value={String(cl.id)}>
                    {cl.name}（{cl.noteCount} 篇）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">目标账号（可选）</p>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="不指定" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.nickname || `账号 #${a.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">生成数量</p>
            <Select value={String(count)} onValueChange={(v) => setCount(Number(v))}>
              <SelectTrigger className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {[3, 5, 8, 10].map((n) => (
                  <SelectItem key={n} value={String(n)}>
                    {n} 个
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <div className="border-t border-border p-4">
          <Button className="w-full" disabled={!collectionId || submitting} onClick={submit}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            生成选题
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/** 选题详情抽屉：评分雷达（横条）+ 深评 + 操作。 */
function TopicDetailDrawer({
  topic,
  onClose,
  onChanged,
}: {
  topic: TopicRow | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [scoring, setScoring] = useState(false);
  const [verdict, setVerdict] = useState("");
  const [advice, setAdvice] = useState("");
  const [busy, setBusy] = useState(false);

  // 切选题时清掉上一条的深评结果
  const [lastId, setLastId] = useState<number | null>(null);
  if (topic?.id !== lastId) {
    setLastId(topic?.id ?? null);
    setVerdict("");
    setAdvice("");
  }

  const runScore = async () => {
    if (!topic || scoring) return;
    setScoring(true);
    try {
      const res = await api.aiTopicScore({ topicId: topic.id });
      setVerdict(res.verdict);
      setAdvice(res.advice);
      onChanged();
    } catch (err) {
      toast.error("深评失败", err instanceof Error ? err.message : undefined);
    } finally {
      setScoring(false);
    }
  };

  const toDraft = async () => {
    if (!topic || busy) return;
    setBusy(true);
    try {
      const res = await api.topicToDraft(topic.id);
      toast.success("已转入草稿工坊", res.draft.title || undefined);
      onChanged();
      navigate(`/drafts/${res.draft.id}`);
    } catch (err) {
      toast.error("转草稿失败", err instanceof Error ? err.message : undefined);
    } finally {
      setBusy(false);
    }
  };

  const detail = (topic?.scoreDetail ?? {}) as Record<string, number>;
  const dimEntries = Object.keys(DIM_LABEL).map((k) => ({
    key: k,
    label: DIM_LABEL[k]!,
    value: detail[k],
  }));

  return (
    <Drawer open={!!topic} onOpenChange={(o) => !o && onClose()} side="right" ariaLabel="选题详情" className="w-full max-w-md">
      {topic && (
        <div className="flex h-full flex-col">
          <div className="border-b border-border px-6 py-4">
            <h2 className="text-base font-semibold text-foreground">{topic.title}</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {SOURCE_LABEL[topic.sourceType]}
              {topic.collectionName ? ` · ${topic.collectionName}` : ""}
              {topic.accountNickname ? ` · ${topic.accountNickname}` : ""} · {timeAgo(topic.createdAt)}
            </p>
          </div>
          <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
            {topic.angle && (
              <div>
                <p className="mb-1.5 text-xs font-medium text-muted-foreground">切入角度</p>
                <p className="whitespace-pre-wrap text-sm leading-relaxed">{topic.angle}</p>
              </div>
            )}
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted-foreground">综合评分</p>
              <div className={cn("text-3xl font-semibold tabular-nums", scoreTone(topic.score))}>
                {topic.score ?? "—"}
                <span className="ml-2 text-sm font-normal">{scoreLabel(topic.score)}</span>
              </div>
            </div>
            <div className="space-y-2">
              {dimEntries.map((d) => (
                <div key={d.key} className="flex items-center gap-3">
                  <span className="w-20 shrink-0 text-xs text-muted-foreground">{d.label}</span>
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary/70 transition-all"
                      style={{ width: `${(d.value ?? 0) * 10}%` }}
                    />
                  </div>
                  <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">
                    {d.value ?? "—"}
                  </span>
                </div>
              ))}
            </div>
            {(verdict || advice) && (
              <div className="rounded-2xl border border-border bg-card p-4">
                <p className="mb-1 text-xs font-medium text-muted-foreground">
                  深评结论{verdict ? `：${verdict}` : ""}
                </p>
                {advice && <p className="text-sm leading-relaxed">{advice}</p>}
              </div>
            )}
            {topic.plannedAt && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <CalendarClock className="size-4" />
                计划 {fmtDateTime(topic.plannedAt)}
              </div>
            )}
          </div>
          <div className="space-y-2 border-t border-border p-4">
            <Button className="w-full" onClick={toDraft} disabled={busy || topic.status === "published"}>
              <NotebookPen className="size-4" />
              {topic.draftId ? "打开已关联草稿" : "转入草稿工坊"}
            </Button>
            <Button variant="ghost" className="w-full" onClick={runScore} disabled={scoring}>
              {scoring ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}
              {topic.score == null ? "AI 深评（七维）" : "重新深评"}
            </Button>
          </div>
        </div>
      )}
    </Drawer>
  );
}

export default function TopicsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [status, setStatus] = useState("");
  const [newOpen, setNewOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [selected, setSelected] = useState<TopicRow | null>(null);

  const topicsQuery = useQuery({
    queryKey: ["topics", status],
    queryFn: () => api.topics(status || undefined),
  });
  const collectionsQuery = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });

  const refresh = () => queryClient.invalidateQueries({ queryKey: ["topics"] });

  const archiveMut = useMutation({
    mutationFn: (t: TopicRow) =>
      api.updateTopic(t.id, { status: t.status === "archived" ? "idea" : "archived" }),
    onSuccess: refresh,
    onError: (e) => toast.error("操作失败", e instanceof Error ? e.message : undefined),
  });
  const deleteMut = useMutation({
    mutationFn: (id: number) => api.deleteTopic(id),
    onSuccess: refresh,
    onError: (e) => toast.error("删除失败", e instanceof Error ? e.message : undefined),
  });

  const items = useMemo(() => topicsQuery.data?.items ?? [], [topicsQuery.data]);
  const collections = collectionsQuery.data?.items ?? [];
  const accounts = accountsQuery.data ?? [];

  if (topicsQuery.isLoading) return <PageLoading />;
  if (topicsQuery.isError) return <PageError error={topicsQuery.error} />;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-foreground">选题池</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            从采集库长出内容方向，评分、排期、转草稿
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={() => setAiOpen(true)} disabled={!collections.length}>
            <Sparkles className="size-4" />
            AI 生成选题
          </Button>
          <Button onClick={() => setNewOpen(true)}>
            <Plus className="size-4" />
            新建选题
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setStatus(t.value)}
            className={cn(
              "rounded-full px-3 py-1 text-xs transition-colors",
              status === t.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!items.length ? (
        <EmptyState
          icon={Lightbulb}
          title={status ? "这个状态下还没有选题" : "选题池还是空的"}
          description="手填一个方向，或让 AI 从采集库里的爆款帮你生成"
          action={
            <Button variant="ghost" onClick={() => setAiOpen(true)} disabled={!collections.length}>
              <Sparkles className="size-4" />
              AI 生成选题
            </Button>
          }
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {items.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className="group rounded-2xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{t.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {t.angle || "（无切入角度）"}
                  </p>
                </div>
                {t.score != null && (
                  <span className={cn("shrink-0 text-lg font-semibold tabular-nums", scoreTone(t.score))}>
                    {t.score}
                  </span>
                )}
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <AnimatedBadge status={STATUS_META[t.status].badge} showIcon={false}>
                  {STATUS_META[t.status].label}
                </AnimatedBadge>
                <span>{SOURCE_LABEL[t.sourceType]}</span>
                {t.collectionName && <span>· {t.collectionName}</span>}
                {t.accountNickname && <span>· {t.accountNickname}</span>}
                {t.plannedAt && (
                  <span className="inline-flex items-center gap-1">
                    <CalendarClock className="size-3" />
                    {fmtDateTime(t.plannedAt)}
                  </span>
                )}
                <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                  <span
                    role="button"
                    tabIndex={0}
                    className="rounded-lg p-1 hover:bg-muted"
                    title={t.status === "archived" ? "恢复为想法" : "归档"}
                    onClick={(e) => {
                      e.stopPropagation();
                      archiveMut.mutate(t);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && archiveMut.mutate(t)}
                  >
                    <Archive className="size-3.5" />
                  </span>
                  <span
                    role="button"
                    tabIndex={0}
                    className="rounded-lg p-1 text-rose-500 hover:bg-muted"
                    title="删除"
                    onClick={(e) => {
                      e.stopPropagation();
                      deleteMut.mutate(t.id);
                    }}
                    onKeyDown={(e) => e.key === "Enter" && deleteMut.mutate(t.id)}
                  >
                    <Trash2 className="size-3.5" />
                  </span>
                </span>
              </div>
            </button>
          ))}
        </div>
      )}

      <NewTopicDrawer
        open={newOpen}
        onOpenChange={setNewOpen}
        collections={collections}
        accounts={accounts}
        onCreated={refresh}
      />
      <AiTopicsDrawer
        open={aiOpen}
        onOpenChange={setAiOpen}
        collections={collections}
        accounts={accounts}
        onCreated={refresh}
      />
      <TopicDetailDrawer
        topic={selected}
        onClose={() => setSelected(null)}
        onChanged={refresh}
      />
    </div>
  );
}
