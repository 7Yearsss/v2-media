import {
  BrainCircuit,
  FileText,
  Flame,
  Lightbulb,
  Loader2,
  MessageCircle,
  Sparkles,
  Target,
  TrendingUp,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionAnalysis } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { NumberTicker } from "@/components/motion/number-ticker";
import { TextReveal } from "@/components/motion/text-reveal";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { AnalysisReport } from "@/components/app/analysis-report";
import { api } from "@/lib/api";
import { formatCount, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";

type AnalysisMeta = Omit<CollectionAnalysis, "report" | "data">;

/** 指标卡：动画数字 + 副标题。 */
function StatCard({
  label,
  value,
  hint,
  suffix,
}: {
  label: string;
  value: number;
  hint: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-2xl border border-border bg-card p-4">
      <div className="text-xs text-muted-foreground">{label}</div>
      <NumberTicker
        value={value}
        locale
        suffix={suffix}
        className="mt-1 block text-2xl font-semibold tabular-nums"
      />
      <div className="mt-1 text-xs text-muted-foreground">{hint}</div>
    </div>
  );
}

/** 动画横条：挂载后从 0 长到目标宽度（key 变化重放）。 */
function BarRow({
  rank,
  title,
  value,
  max,
  delay,
}: {
  rank?: number;
  title: string;
  value: number;
  max: number;
  delay: number;
}) {
  const pct = max > 0 ? Math.max(4, (value / max) * 100) : 0;
  // 挂载后才给目标宽度，让 transition 从 0 长出来
  const [w, setW] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setW(pct), delay);
    return () => clearTimeout(t);
  }, [pct, delay]);
  return (
    <div className="group flex items-center gap-3">
      {rank != null && (
        <span
          className={cn(
            "grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold",
            rank <= 3 ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
          )}
        >
          {rank}
        </span>
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-sm">{title}</span>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatCount(value)}
          </span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary transition-[width] duration-700 ease-out"
            style={{ width: `${w}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/** 入场渐显：挂载后延迟切入。 */
function FadeIn({ delay, children }: { delay: number; children: React.ReactNode }) {
  const [on, setOn] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setOn(true), delay);
    return () => clearTimeout(t);
  }, [delay]);
  return (
    <div
      style={{
        opacity: on ? 1 : 0,
        transform: on ? "none" : "translateY(6px)",
        transition: "opacity .45s ease, transform .45s ease",
      }}
    >
      {children}
    </div>
  );
}

/** AI 洞察分组卡。 */
function InsightCard({
  icon: Icon,
  title,
  items,
  accent,
}: {
  icon: typeof Flame;
  title: string;
  items: string[];
  accent: string;
}) {
  if (!items.length) return null;
  return (
    <div className="rounded-2xl border border-border bg-card p-5">
      <div className={cn("flex items-center gap-2 text-sm font-semibold", accent)}>
        <Icon className="size-4" />
        {title}
      </div>
      <ul className="mt-3 flex flex-col gap-2.5">
        {items.map((t, i) => (
          <li key={i}>
            <FadeIn delay={i * 120}>
              <span className="flex gap-2 text-sm leading-6 text-foreground/90">
                <span className={cn("mt-2.5 size-1 shrink-0 rounded-full", accent.replace("text-", "bg-"))} />
                {t}
              </span>
            </FadeIn>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 旧版（v1）报告的回看视图。 */
function LegacyView({ a }: { a: CollectionAnalysis }) {
  const { stats, insight } = a.data ?? {};
  if (!stats) {
    // 旧格式/兜底：原文展示
    return (
      <div className="whitespace-pre-wrap rounded-2xl border border-border bg-card p-6 text-sm leading-7">
        {a.report || "（无数据）"}
      </div>
    );
  }
  const totalEngagement =
    stats.totalLikes + stats.totalCollects + stats.totalComments + stats.totalShares;
  const maxNote = stats.topNotes[0]?.engagement ?? 0;
  const maxTag = stats.topTags[0]?.count ?? 0;
  const commentRate =
    stats.totalLikes > 0 ? Math.round((stats.totalComments / stats.totalLikes) * 100) : 0;

  return (
    <div className="flex flex-col gap-5">
      {/* 一句话结论 */}
      {insight?.summary ? (
        <div className="rounded-2xl border border-primary/25 bg-gradient-to-r from-primary/10 to-transparent p-5">
          <TextReveal
            text={insight.summary}
            className="text-base font-medium leading-7"
            split="word"
            stagger={0.02}
            once
          />
        </div>
      ) : null}

      {/* 指标卡 */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="分析笔记" value={a.noteCount} hint="本库互动 top" />
        <StatCard label="总互动量" value={totalEngagement} hint="赞 + 藏 + 评 + 分享" />
        <StatCard label="平均互动" value={stats.avgEngagement} hint="每篇笔记" />
        <StatCard label="评赞比" value={commentRate} hint="越高讨论度越强" suffix="%" />
      </div>
      {stats.coverage && stats.coverage.withDetail < stats.coverage.total && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-xs text-amber-600 dark:text-amber-400">
          {stats.coverage.total} 篇里只有 {stats.coverage.withDetail} 篇进过详情页（收藏/评论/分享/正文要进详情页才采得到）—— 结论偏曝光吸引力，点进高赞笔记详情后再跑一轮会更准
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        {/* 爆款榜 */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Flame className="size-4 text-orange-500" />
            爆款榜 · 按互动量
          </div>
          <div className="mt-4 flex flex-col gap-3.5">
            {stats.topNotes.map((n, i) => (
              <BarRow key={n.noteId} rank={i + 1} title={n.title} value={n.engagement} max={maxNote} delay={i * 80} />
            ))}
          </div>
        </div>

        {/* 标签热度 */}
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <TrendingUp className="size-4 text-emerald-500" />
            高频标签 · 库里在聚什么话题
          </div>
          <div className="mt-4 flex flex-col gap-3.5">
            {stats.topTags.length ? (
              stats.topTags.map((t, i) => (
                <BarRow key={t.tag} title={`#${t.tag}`} value={t.count} max={maxTag} delay={i * 60} />
              ))
            ) : (
              <div className="text-sm text-muted-foreground">这批笔记没带标签</div>
            )}
          </div>
        </div>
      </div>

      {/* AI 洞察三卡 */}
      {insight ? (
        <div className="grid gap-4 lg:grid-cols-3">
          <InsightCard icon={Flame} title="爆款共性" items={insight.patterns ?? []} accent="text-orange-500" />
          <InsightCard icon={Lightbulb} title="机会点" items={insight.opportunities ?? []} accent="text-amber-500" />
          <InsightCard icon={Target} title="行动建议" items={insight.actions ?? []} accent="text-primary" />
        </div>
      ) : null}

      {/* AI 点名的爆款原因 */}
      {insight?.topNotes?.length ? (
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <MessageCircle className="size-4 text-sky-500" />
            它们为什么火
          </div>
          <div className="mt-3 grid gap-3 md:grid-cols-2">
            {insight.topNotes.map((n, i) => (
              <div key={i} className="rounded-xl bg-muted/50 p-3.5">
                <div className="truncate text-sm font-medium">{n.title}</div>
                <div className="mt-1 text-xs leading-5 text-muted-foreground">{n.why}</div>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {/* 结构化失败时的原文兜底 */}
      {!insight && a.report ? (
        <div className="whitespace-pre-wrap rounded-2xl border border-border bg-card p-6 text-sm leading-7">
          {a.report}
        </div>
      ) : null}
    </div>
  );
}

export default function AnalysisPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [colId, setColId] = useState<number | null>(null);
  const [active, setActive] = useState<CollectionAnalysis | null>(null);
  // 目标账号定位：可选，填了建议和选题会贴合它；记在本机
  const [positioning, setPositioning] = useState(() => {
    try {
      return localStorage.getItem("v2m.analysis.positioning") ?? "";
    } catch {
      return "";
    }
  });
  const updatePositioning = (v: string) => {
    setPositioning(v);
    try {
      localStorage.setItem("v2m.analysis.positioning", v);
    } catch {
      /* 隐私模式等：不记就不记 */
    }
  };
  // 当前选中库的快照：异步返回时用它丢弃过期结果（换库后旧库报告不顶上来）
  const colIdRef = useRef<number | null>(null);
  colIdRef.current = colId;

  const cols = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const analyses = useQuery({
    queryKey: ["analyses", colId],
    queryFn: () => api.collectionAnalyses(colId!),
    enabled: colId != null,
  });
  const loadAnalysis = useMutation({
    mutationFn: ({ cid, aid }: { cid: number; aid: number }) =>
      api.collectionAnalysis(cid, aid),
    onSuccess: (row) => {
      if (row.collectionId === colIdRef.current) setActive(row);
    },
    onError: (e) => toast.error("读取报告失败", e instanceof Error ? e.message : undefined),
  });
  const analyze = useMutation({
    mutationFn: ({ id, positioning }: { id: number; positioning: string }) =>
      api.analyzeCollection(id, positioning || undefined),
    onSuccess: (row) => {
      // 后台异步跑：先拿到 running 行（已含代码算好的信号图），再轮询到完成
      void queryClient.invalidateQueries({ queryKey: ["analyses", row.collectionId] });
      if (row.collectionId === colIdRef.current) setActive(row);
    },
    onError: (e) => toast.error("分析失败", e instanceof Error ? e.message : undefined),
  });

  // 生成中：每 2.5s 拉一次，直到 done/failed
  const running = active?.status === "running" ? active : null;
  const poll = useQuery({
    queryKey: ["analysis-run", running?.collectionId, running?.id],
    queryFn: () => api.collectionAnalysis(running!.collectionId, running!.id),
    enabled: !!running,
    refetchInterval: 2500,
    gcTime: 0,
  });
  const polled = poll.data;
  useEffect(() => {
    if (!polled || polled.status === "running") return;
    void queryClient.invalidateQueries({ queryKey: ["analyses", polled.collectionId] });
    if (polled.collectionId !== colIdRef.current) return;
    setActive((cur) => (cur?.id === polled.id ? polled : cur));
    if (polled.status === "done") toast.success("分析完成");
    else toast.error("分析失败", polled.error ?? undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [polled]);

  const colName = useMemo(
    () => cols.data?.items.find((x) => x.id === colId)?.name ?? "",
    [cols.data, colId],
  );

  if (cols.isLoading) return <PageLoading />;
  if (cols.isError) return <PageError error={cols.error} onRetry={() => void cols.refetch()} />;

  return (
    <div className="flex flex-col gap-6 p-6">
      <div className="flex flex-wrap items-center gap-3">
        <BrainCircuit className="size-5 text-primary" />
        <h1 className="text-lg font-semibold">AI 分析</h1>
      </div>

      {/* 采集库选择 */}
      <div className="flex flex-wrap items-center gap-2">
        {(cols.data?.items ?? []).map((col) => (
          <button
            key={col.id}
            onClick={() => {
              setColId(col.id);
              setActive(null);
            }}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm transition-colors",
              colId === col.id
                ? "border-primary bg-primary/10 text-primary"
                : "border-border hover:border-foreground/30",
            )}
          >
            {col.name}
            <span className="text-xs text-muted-foreground">{col.noteCount}</span>
          </button>
        ))}
        {!(cols.data?.items.length ?? 0) && (
          <EmptyState
            title="还没有采集库"
            description="先在插件 popup 或内容库页创建一个库，并采集一些笔记进来"
          />
        )}
        {colId != null && (
          <Button
            size="sm"
            disabled={analyze.isPending || !!running}
            onClick={() => analyze.mutate({ id: colId, positioning })}
            className="ml-1"
          >
            {analyze.isPending || running ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 size-4" />
            )}
            {analyze.isPending || running ? "分析中…" : "开始分析"}
          </Button>
        )}
        {colId != null && (
          <input
            value={positioning}
            onChange={(e) => updatePositioning(e.target.value)}
            maxLength={60}
            placeholder="我的账号定位（选填，如：职场效率/平价护肤）"
            className="h-9 w-72 rounded-full border border-border bg-card px-4 text-sm outline-none transition-colors placeholder:text-muted-foreground/60 focus:border-primary"
          />
        )}
      </div>

      {colId != null && (
        <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
          {/* 历史报告 */}
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">历史报告</div>
            {analyses.isLoading && <PageLoading />}
            {analyses.isError && (
              <PageError error={analyses.error} onRetry={() => void analyses.refetch()} />
            )}
            {(analyses.data?.items ?? []).map((a: AnalysisMeta) => (
              <button
                key={a.id}
                onClick={() => loadAnalysis.mutate({ cid: colId, aid: a.id })}
                className={cn(
                  "flex flex-col gap-0.5 rounded-xl border p-3 text-left transition-colors",
                  active?.id === a.id
                    ? "border-primary bg-primary/5"
                    : "border-border hover:border-foreground/20",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm">
                  <FileText className="size-3.5" />
                  {a.noteCount} 篇笔记
                  {a.status === "running" && <Loader2 className="size-3 animate-spin text-primary" />}
                  {a.status === "failed" && <span className="text-[10px] text-rose-500">失败</span>}
                </span>
                <span className="text-xs text-muted-foreground">{timeAgo(a.createdAt)}</span>
              </button>
            ))}
            {analyses.data && !analyses.data.items.length && (
              <div className="text-xs text-muted-foreground">还没有报告，点「开始分析」生成</div>
            )}
          </div>

          {/* 报告区 */}
          <div className="min-w-0">
            {analyze.isPending && (
              <div className="flex flex-col items-center gap-3 py-16">
                <Loader2 className="size-8 animate-spin text-muted-foreground" />
                <TextShimmer className="text-sm text-muted-foreground">
                  正在读取「{colName}」…
                </TextShimmer>
              </div>
            )}
            {active?.status === "failed" ? (
              <div className="flex flex-col items-start gap-2 rounded-3xl border border-rose-500/30 bg-rose-500/10 p-6">
                <div className="font-semibold text-rose-600">分析没跑完</div>
                <div className="text-xs text-muted-foreground">{active.error || "AI 调用失败"}</div>
              </div>
            ) : active ? (
              active.data?.stats?.signals ? (
                <AnalysisReport key={active.id} a={active} onTopicAdded={() => void queryClient.invalidateQueries({ queryKey: ["topics"] })} />
              ) : (
                <LegacyView key={active.id} a={active} />
              )
            ) : (
              !analyze.isPending && (
                <EmptyState
                  title="选择库后点「开始分析」"
                />
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
