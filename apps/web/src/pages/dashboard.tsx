import { ArrowUpRight, FileText, LibraryBig, NotebookPen, Plus, Sparkles } from "lucide-react";
import { Link, useNavigate } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiRun, Draft } from "@v2media/shared";
import { CollectionTrend } from "@/components/app/collection-trend";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { api, captureSession, isCurrentSession, mediaUrl, SessionChangedError } from "@/lib/api";
import { useRuntime } from "@/lib/hooks/use-runtime";
import { formatCount, timeAgo, UNKNOWN_PUBLICATION_MESSAGE as unknownPublication, publicationStatusMeta } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { useWorkspaceAccount } from "@/lib/account-context";
import { useObservation } from "@/lib/hooks/use-observation";

const runName: Record<AiRun["kind"], string> = { analysis: "资料分析", topic_generate: "生成选题", topic_score: "选题深评" };
const runLabel: Record<AiRun["status"], string> = { queued: "等待处理", running: "处理中", done: "已完成", failed: "需要重试", canceled: "已停止" };
const jobMessage = (error?: string) => error === unknownPublication ? "请勿直接重发" : error;

function HomeDraftCard({ draft }: { draft: Draft }) {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = draft.images[0]?.url ? mediaUrl(draft.images[0].url) : null;
  return <Link to={`/drafts/${draft.id}`} className="home-draft-card group block">
    <div className="home-draft-cover">
      {url && url !== failedUrl ? <img src={url} alt="" loading="lazy" decoding="async" onError={() => setFailedUrl(url)} />
        : <div className="flex flex-col items-center gap-3 px-5 text-center text-muted-foreground"><FileText className="size-8" strokeWidth={1.25} /><span className="text-xs">{url ? "封面暂不可用" : "待添加封面"}</span></div>}
    </div>
    <h3 className="mt-3 line-clamp-2 text-[15px] font-medium leading-6">{draft.title || "未命名草稿"}</h3>
    <p className="mt-1.5 text-xs text-muted-foreground">{draft.status === "ready" ? "待确认发布" : draft.status === "published" ? "已有发布记录" : "草稿"}<span className="ml-3">{timeAgo(draft.updatedAt)}</span></p>
  </Link>;
}

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
  const recentDrafts = drafts.data?.slice(0, 3) ?? [];
  const counts = [
    { label: "笔记", value: stats.notes, link: "/library" },
    { label: "草稿", value: stats.drafts, link: "/drafts" },
    { label: "账号", value: stats.accounts, link: "/accounts" },
    { label: "待处理发布", value: jobs.isSuccess ? pending.length : null, link: "/publish" },
  ];
  return <div className="workspace-page space-y-6">
    <header className="workspace-page-header"><div><h1>今日</h1><p>{new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date())}</p></div>
      <Button className="workspace-action" size="md" disabled={readOnly || !workspaceAccount.canCreate || create.isPending} onClick={() => create.mutate()}><Plus className="size-4" />新建草稿</Button></header>
    <div className="home-stats">
      {counts.map(item => <Link key={item.label} to={item.link} className="home-stat">
        <strong>{item.value === null ? "—" : formatCount(item.value)}</strong><span>{item.label}</span>
      </Link>)}
    </div>
    <div className="home-board">
      <section className="min-w-0">
        <div className="mb-5 flex items-center justify-between"><h2 className="text-[17px] font-semibold">最近草稿</h2><Link to="/drafts" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">全部<ArrowUpRight className="size-3.5" /></Link></div>
        {drafts.isPending ? <PageLoading label="读取草稿…" /> : drafts.isError ? <PageError error={drafts.error} onRetry={drafts.refetch} /> : recentDrafts.length ? <div className="home-draft-grid">
          {recentDrafts.map(draft => <HomeDraftCard key={draft.id} draft={draft} />)}
        </div> : <EmptyState icon={NotebookPen} title="暂无草稿" action={<Button size="sm" variant="outline" disabled={readOnly || create.isPending} onClick={() => create.mutate()}>新建草稿</Button>} className="py-12" />}
      </section>
      <section className="home-attention min-w-0">
        <div className="mb-3"><h2 className="text-[17px] font-semibold">待处理</h2></div>
        {jobs.isError || runs.isError ? <PageError error={jobs.error ?? runs.error} onRetry={() => { void jobs.refetch(); void runs.refetch(); }} /> : jobs.isPending || runs.isPending ? <PageLoading label="读取任务…" /> : activeRuns.length || pending.length ? <div className="divide-y divide-border">
          {activeRuns.slice(0, 3).map(run => <Link key={`ai-${run.id}`} to={run.kind === "analysis" ? "/analysis" : "/topics"} className="flex items-start gap-3 rounded-xl py-4 hover:bg-muted/30"><Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><p className="text-sm">{runName[run.kind]}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{run.errorMessage || (run.status === "queued" ? "任务已保存，等待处理" : "关闭页面后仍会继续处理")}</p></div><AnimatedBadge size="sm" status={run.status === "failed" ? "danger" : "neutral"}>{runLabel[run.status]}</AnimatedBadge></Link>)}
          {pending.slice(0, 3).map(job => <Link key={`publish-${job.id}`} to={`/publish?job=${job.id}`} className="flex items-start gap-3 rounded-xl py-4 hover:bg-muted/30"><div className="min-w-0 flex-1"><p className="line-clamp-2 text-sm font-medium leading-6">{job.draftSnapshot?.title || `发布任务 #${job.id}`}</p><p className="mt-1 line-clamp-2 text-xs leading-5 text-muted-foreground">{jobMessage(job.error) || (job.status === "failed" ? "请查看失败记录" : job.status === "running" ? "等待发布结果" : "等待插件上线")}</p></div><AnimatedBadge size="sm" status={publicationStatusMeta(job).status}>{publicationStatusMeta(job).label}</AnimatedBadge></Link>)}
        </div> : <div className="px-5 py-8"><p className="text-sm text-muted-foreground">暂无待处理任务</p></div>}
      </section>
    </div>
    <section className="home-trend">
      <div className="mb-5 flex items-center justify-between"><div className="flex items-baseline gap-2"><h2 className="workspace-section-title">采集趋势</h2><span className="text-xs text-muted-foreground">近 7 天</span></div><Link to="/library" className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"><LibraryBig className="size-3.5" />资料库</Link></div>
      {stats.trend.length ? <CollectionTrend points={stats.trend} /> : <EmptyState title="暂无采集记录" className="py-8" />}
    </section>
  </div>;
}
