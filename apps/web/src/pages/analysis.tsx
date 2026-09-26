import { BrainCircuit, FileText, Loader2, Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionAnalysis } from "@v2media/shared";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useToast } from "@/lib/toast";

type AnalysisMeta = Omit<CollectionAnalysis, "report">;

export default function AnalysisPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [colId, setColId] = useState<number | null>(null);
  const [active, setActive] = useState<CollectionAnalysis | null>(null);

  const cols = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const analyses = useQuery({
    queryKey: ["analyses", colId],
    queryFn: () => api.collectionAnalyses(colId!),
    enabled: colId != null,
  });
  const loadAnalysis = useMutation({
    mutationFn: ({ cid, aid }: { cid: number; aid: number }) =>
      api.collectionAnalysis(cid, aid),
    onSuccess: setActive,
    onError: (e) => toast.error("读取报告失败", e instanceof Error ? e.message : undefined),
  });
  const analyze = useMutation({
    mutationFn: (id: number) => api.analyzeCollection(id),
    onSuccess: (row) => {
      setActive(row);
      void queryClient.invalidateQueries({ queryKey: ["analyses", colId] });
      toast.success("分析完成");
    },
    onError: (e) => toast.error("分析失败", e instanceof Error ? e.message : undefined),
  });

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
        <span className="text-sm text-muted-foreground">
          选一个采集库，让 AI 分析哪些内容火、为什么火
        </span>
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
            disabled={analyze.isPending}
            onClick={() => analyze.mutate(colId)}
            className="ml-1"
          >
            {analyze.isPending ? (
              <Loader2 className="mr-1.5 size-4 animate-spin" />
            ) : (
              <Sparkles className="mr-1.5 size-4" />
            )}
            {analyze.isPending ? "分析中…" : "开始分析"}
          </Button>
        )}
      </div>

      {colId != null && (
        <div className="grid gap-6 lg:grid-cols-[240px_1fr]">
          {/* 历史报告 */}
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium text-muted-foreground">历史报告</div>
            {analyses.isLoading && <PageLoading />}
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
                </span>
                <span className="text-xs text-muted-foreground">{timeAgo(a.createdAt)}</span>
              </button>
            ))}
            {analyses.data && !analyses.data.items.length && (
              <div className="text-xs text-muted-foreground">还没有报告，点「开始分析」生成</div>
            )}
          </div>

          {/* 报告正文 */}
          <div className="min-w-0">
            {analyze.isPending && (
              <div className="flex flex-col items-center gap-3 py-16 text-muted-foreground">
                <Loader2 className="size-8 animate-spin" />
                <div className="text-sm">正在让 AI 阅读「{colName}」里的笔记…</div>
              </div>
            )}
            {active ? (
              <div className="rounded-2xl border border-border bg-card p-6">
                <div className="mb-4 flex items-center gap-2">
                  <AnimatedBadge>基于 {active.noteCount} 篇笔记</AnimatedBadge>
                  <span className="text-xs text-muted-foreground">{timeAgo(active.createdAt)}</span>
                </div>
                {/* 模型输出 markdown 文本，直接保留换行渲染 */}
                <div className="whitespace-pre-wrap text-sm leading-7">{active.report}</div>
              </div>
            ) : (
              !analyze.isPending && (
                <EmptyState
                  title="选择库后点「开始分析」"
                  description="报告会列出爆款 TOP、共性规律、机会点和行动建议"
                />
              )
            )}
          </div>
        </div>
      )}
    </div>
  );
}
