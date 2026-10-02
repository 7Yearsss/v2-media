import { ArrowUpRight, FileText, LibraryBig, NotebookPen, Plus, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiRun, CollectSource } from "@v2media/shared";
import { CompositionChart, type CompositionChartSeries } from "@/components/charts/composition-chart";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { api, captureSession, isCurrentSession, mediaUrl, SessionChangedError } from "@/lib/api";
import { useRuntime } from "@/lib/hooks/use-runtime";
import { JOB_STATUS_META, SOURCE_LABEL, formatCount, timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { useWorkspaceAccount } from "@/lib/account-context";
import { useObservation } from "@/lib/hooks/use-observation";

const runName: Record<AiRun["kind"], string> = { analysis: "资料分析", topic_generate: "生成选题", topic_score: "选题深评" };
const runLabel: Record<AiRun["status"], string> = { queued: "等待处理", running: "处理中", done: "已完成", failed: "需要重试", canceled: "已停止" };
const unknownPublication = "发布执行租约已失效，执行结果未知，请人工核对，勿直接重发";
const jobMessage = (error?: string) => error === unknownPublication ? "请勿直接重发" : error;

export default function DashboardPage() {
  const navigate = useNavigate(), client = useQueryClient(), toast = useToast(), { readOnly } = useRuntime();
  const workspaceAccount = useWorkspaceAccount(), { interval } = useObservation();
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const drafts = useQuery({ queryKey: ["drafts"], queryFn: api.drafts });
  const jobs = useQuery({ queryKey: ["publish-jobs"], queryFn: api.jobs });
  const runs = useQuery({ queryKey: ["ai-runs", "dashboard"], queryFn: () => api.aiRuns(), refetchInterval: q => interval(!!q.state.data?.items.some(r => ["queued", "running"].includes(r.status)), 2500, false, q.state.fetchFailureCount) });
  const create = useMutation({ mutationFn: async () => {
    if (!workspaceAccount.canCreate) throw new Error("请先确认有效的写作账号或选择通用风格");
    const session = captureSession(), draft = await api.createDraft({ accountId: workspaceAccount.accountId ?? undefined });
    if (!isCurrentSession(session)) throw new SessionChangedError(); return { session, draft };
  }, onSuccess: ({ session, draft }) => { if (!isCurrentSession(session)) return; void client.invalidateQueries({ queryKey: ["drafts"] }); if (mounted.current) navigate(`/drafts/${draft.id}`); },
  onError: error => { if (mounted.current && !(error instanceof SessionChangedError)) toast.error("新建草稿失败", error instanceof Error ? error.message : undefined); } });
  if (overview.isPending) return <PageLoading label="加载今日工作…" />;
  if (overview.isError) return <PageError error={overview.error} onRetry={overview.refetch} />;
  const stats = overview.data;
  const pending = (jobs.data ?? []).filter(job => ["pending", "running", "failed"].includes(job.status));
  const activeRuns = (runs.data?.items ?? []).filter(run => ["queued", "running", "failed"].includes(run.status));
  const recentDrafts = drafts.data?.slice(0, 5) ?? [];
  const counts = [
    { label: "笔记", value: stats.notes, link: "/library" },
    { label: "草稿", value: stats.drafts, link: "/drafts" },
    { label: "账号", value: stats.accounts, link: "/accounts" },
    { label: "待处理发布", value: jobs.isSuccess ? pending.length : null, link: "/publish" },
  ];
  const palette: Record<string, string> = { search: "#d94038", homefeed: "#dfaa59", collect_page: "#6b9b8d", like_page: "#9988bf", user_posted: "#7c9fbe", detail: "#9ca4b1" };
  const series: CompositionChartSeries[] = stats.trendBySource.length ? stats.trendBySource.map(source => ({ id: source.source, name: SOURCE_LABEL[source.source as CollectSource] ?? source.source, color: palette[source.source] ?? "#9ca4b1", values: source.values }))
    : stats.trend.length ? [{ id: "collect", name: "采集量", color: "#d94038", values: stats.trend.map(p => p.count) }] : [];
  return <div className="workspace-page space-y-7">
    <h1 className="sr-only">今日</h1>
    <div className="workspace-panel grid grid-cols-2 md:grid-cols-4">
      {counts.map(item => <Link key={item.label} to={item.link} className="workspace-metric transition-colors hover:bg-muted/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        <p className="text-xs text-muted-foreground">{item.label}</p><p className="mt-2 text-2xl font-semibold tabular-nums tracking-tight">{item.value === null ? "—" : formatCount(item.value)}</p>
      </Link>)}
    </div>
    <div className="grid gap-6 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,1fr)]">
      <section className="workspace-panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-border px-5 py-4"><h2 className="workspace-section-title">草稿</h2><div className="flex items-center gap-3"><Link to="/drafts" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">全部<ArrowUpRight className="size-3.5" /></Link><Button size="sm" disabled={readOnly || !workspaceAccount.canCreate || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" />新建草稿</Button></div></div>
        {drafts.isPending ? <PageLoading label="读取草稿…" /> : drafts.isError ? <PageError error={drafts.error} onRetry={drafts.refetch} /> : recentDrafts.length ? <div className="divide-y divide-border">
          {recentDrafts.map(draft => <Link key={draft.id} to={`/drafts/${draft.id}`} className="group flex min-w-0 items-center gap-4 px-5 py-4 transition-colors hover:bg-muted/30">
            <div className="grid h-14 w-11 shrink-0 place-items-center overflow-hidden rounded-md bg-muted text-muted-foreground">{draft.images[0]?.url ? <img className="size-full object-cover" src={mediaUrl(draft.images[0].url)} alt="" /> : <FileText className="size-5" />}</div>
            <div className="min-w-0 flex-1"><p className="truncate text-sm font-medium">{draft.title || "未命名草稿"}</p><p className="mt-1 truncate text-xs text-muted-foreground">{draft.content || "从一个想法开始写"}</p></div>
            <div className="shrink-0 text-right"><span className="text-[11px] text-muted-foreground">{draft.status === "ready" ? "待确认发布" : draft.status === "published" ? "已有发布记录" : "草稿"}</span><p className="mt-1 text-[11px] text-muted-foreground">{timeAgo(draft.updatedAt)}</p></div>
          </Link>)}
        </div> : <EmptyState icon={NotebookPen} title="暂无草稿" action={<Button size="sm" variant="outline" disabled={readOnly || create.isPending} onClick={() => create.mutate()}>新建草稿</Button>} className="py-12" />}
      </section>
      <section className="workspace-panel overflow-hidden">
        <div className="border-b border-border px-5 py-4"><h2 className="workspace-section-title">待处理</h2></div>
        {jobs.isError || runs.isError ? <PageError error={jobs.error ?? runs.error} onRetry={() => { void jobs.refetch(); void runs.refetch(); }} /> : jobs.isPending || runs.isPending ? <PageLoading label="读取任务…" /> : activeRuns.length || pending.length ? <div className="divide-y divide-border">
          {activeRuns.slice(0, 3).map(run => <Link key={`ai-${run.id}`} to={run.kind === "analysis" ? "/analysis" : "/topics"} className="flex items-start gap-3 px-5 py-4 hover:bg-muted/30"><Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">{runName[run.kind]}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{run.errorMessage || (run.status === "queued" ? "任务已保存，等待处理" : "关闭页面后仍会继续处理")}</p></div><AnimatedBadge size="sm" status={run.status === "failed" ? "danger" : "neutral"}>{runLabel[run.status]}</AnimatedBadge></Link>)}
          {pending.slice(0, 3).map(job => <Link key={`publish-${job.id}`} to="/publish" className="flex items-start gap-3 px-5 py-4 hover:bg-muted/30"><div className="min-w-0 flex-1"><p className="truncate text-sm">{job.draftSnapshot?.title || `发布任务 #${job.id}`}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{jobMessage(job.error) || (job.status === "failed" ? "请查看失败记录" : job.status === "running" ? "等待发布结果" : "等待插件上线")}</p></div><AnimatedBadge size="sm" status={job.error === unknownPublication ? "warning" : JOB_STATUS_META[job.status].status}>{job.error === unknownPublication ? "待核对" : JOB_STATUS_META[job.status].label}</AnimatedBadge></Link>)}
        </div> : <div className="px-5 py-8"><p className="text-sm text-muted-foreground">暂无待处理任务</p></div>}
      </section>
    </div>
    <section className="workspace-panel p-5">
      <div className="mb-5 flex items-center justify-between"><div className="flex items-baseline gap-2"><h2 className="workspace-section-title">采集趋势</h2><span className="text-xs text-muted-foreground">近 7 天</span></div><Link to="/library" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><LibraryBig className="size-3.5" />资料库</Link></div>
      {series.length ? <CompositionChart view="area" series={series} periods={stats.trend.map((p, i) => p.label || `D${i + 1}`)} label="近7天采集趋势" formatValue={v => `${formatCount(v)} 条`} /> : <EmptyState title="暂无采集记录" className="py-8" />}
    </section>
  </div>;
}
