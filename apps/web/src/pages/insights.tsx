import { useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, RefreshCw, Sparkles } from "lucide-react";
import type { InsightMetric, MetricField, MetricsHorizon, PostmortemReport } from "@v2media/shared";
import { METRIC_FIELDS } from "@v2media/shared";
import { api } from "@/lib/api";
import { Button } from "@/components/motion/button";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { MetricTimeline } from "@/components/app/metric-timeline";
import { useToast } from "@/lib/toast";
import { useRuntime } from "@/lib/hooks/use-runtime";

const LABELS: Record<MetricField, string> = { likes: "点赞", collects: "收藏", comments: "评论", shares: "分享", views: "浏览", exposure: "曝光" };
const n = (v: number | null | undefined) => v === null || v === undefined ? "未采到" : v.toLocaleString();
const date = (v: string | null | undefined) => v ? new Date(v).toLocaleString() : "未采到";
const age = (ms: number | null) => ms === null ? "发布时间未知" : ms < 0 ? "采样早于发布时间" : `${(ms / 3_600_000).toFixed(1)} 小时`;
const selectClass = "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

function SnapshotTable({ points }: { points: InsightMetric[] }) {
  return <div className="overflow-x-auto rounded-xl border border-border"><table className="w-full whitespace-nowrap text-left text-xs tabular-nums">
    <caption className="sr-only">每次真实回采的指标快照，缺失显示未采到</caption>
    <thead className="bg-muted/40 text-muted-foreground"><tr><th className="p-3">快照 / 实采时间</th><th className="p-3">发布后</th>{METRIC_FIELDS.map(k => <th key={k} className="p-3">{LABELS[k]}</th>)}<th className="p-3">延迟 / 来源</th></tr></thead>
    <tbody>{points.map(p => <tr key={p.id} className="border-t border-border"><td className="p-3">#{p.id}　{date(p.capturedAt)}</td><td className="p-3">{age(p.ageMs)}</td>{METRIC_FIELDS.map(k => <td className="p-3" key={k}>{n(p[k])}</td>)}
      <td className="p-3">{p.delayMs === null ? "排期未知" : `${Math.round(p.delayMs / 60000)} 分钟`} / {p.source === "unknown" ? "未记录" : p.source === "browser_readback" ? "浏览器回采" : p.source}</td></tr>)}</tbody>
  </table></div>;
}
function Report({ report }: { report: PostmortemReport }) {
  return <section className="space-y-4 rounded-xl border border-border p-5">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">复盘 #{report.id}</h3><span className="text-xs text-muted-foreground">{date(report.createdAt)} / {report.status === "done" ? "已完成" : report.status === "failed" ? "失败" : "生成中"}</span></div>
    <p className="text-xs text-muted-foreground">依据 {report.evidence.metrics.length} 条冻结快照；后续回采不改写这份报告。{report.engine === "data_only" ? "数据检查（未调用 AI）" : report.model}</p>
    {report.error && <p role="alert" className="text-sm text-destructive">{report.error}</p>}
    {report.evidence.gaps.length > 0 && <details><summary className="cursor-pointer text-xs text-amber-600">数据缺口与结论边界（{report.evidence.gaps.length}）</summary><ul className="mt-2 list-disc space-y-1 pl-5 text-xs leading-6 text-muted-foreground">{report.evidence.gaps.map(g => <li key={g}>{g}</li>)}</ul></details>}
    {report.insight && <div className="grid gap-5 lg:grid-cols-3">
      <div><h4 className="mb-2 text-xs font-semibold">实际观察</h4>{report.insight.evidence.length ? report.insight.evidence.map((e, i) => <p key={i} className="mb-3 text-sm leading-6">{e.observation}<span className="block text-xs text-muted-foreground">依据快照 {e.metricIds.map(id => `#${id}`).join("、")}</span></p>) : <p className="text-sm leading-6 text-muted-foreground">当前数据不足以评价公开内容表现。</p>}</div>
      <div><h4 className="mb-2 text-xs font-semibold">可能原因</h4>{report.insight.hypotheses.map((e, i) => <div key={i} className="mb-3 space-y-1 text-sm leading-6"><p>{e.possibleReason}</p><p className="text-xs text-muted-foreground">{e.limitation}；快照 {e.metricIds.map(id => `#${id}`).join("、")}</p></div>)}</div>
      <div><h4 className="mb-2 text-xs font-semibold">下一篇实验</h4>{report.insight.experiments.map((e, i) => <div key={i} className="mb-3 space-y-1 text-sm leading-6"><p>{e.change}</p><p className="text-xs text-muted-foreground">观察：{e.observe}</p></div>)}</div>
    </div>}
  </section>;
}
function NoteReview({ id }: { id: number }) {
  const { readOnly } = useRuntime();
  const toast = useToast(), client = useQueryClient();
  const [busy, setBusy] = useState(false), [field, setField] = useState<MetricField>("likes");
  const detail = useQuery({ queryKey: ["insight-note", id], queryFn: () => api.insightNote(id),
    refetchInterval: q => q.state.data?.reports.some(r => ["queued", "running"].includes(r.status)) ? 2000 : 30000 });
  const generate = async () => { setBusy(true); try { await api.postmortem(id, Boolean(detail.data?.reports.length)); await client.invalidateQueries({ queryKey: ["insight-note", id] }); }
    catch (e) { toast.error("复盘失败", e instanceof Error ? e.message : undefined); } finally { setBusy(false); } };
  if (detail.isPending) return <PageLoading />;
  if (detail.isError) return <PageError error={detail.error} onRetry={() => void detail.refetch()} />;
  const { note, evidence, reports } = detail.data;
  const running = reports.some(r => ["queued", "running"].includes(r.status));
  return <div className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:px-6">
    <Link to="/insights" className="inline-flex items-center gap-2 text-xs text-muted-foreground"><ArrowLeft className="size-4" />返回数据洞察</Link>
    <div className="flex flex-wrap items-start justify-between gap-4"><div><h1 className="text-xl font-semibold">{note.title || "无标题笔记"}</h1><p className="mt-2 text-xs text-muted-foreground">{note.accountName}　发布任务 #{note.publishJobId}　{note.visibility === "public" ? "公开" : note.visibility === "private" ? "仅自己可见" : "好友可见"}　{note.outcome === "verified" ? "已核对" : "待核对"}</p></div>
      <Button size="sm" onClick={() => void generate()} disabled={readOnly || busy || running}><Sparkles className="size-4" />{busy || running ? "复盘生成中…" : reports.length ? "按最新数据重新复盘" : "生成单篇复盘"}</Button></div>
    <div className="grid gap-3 border-y border-border py-4 text-xs sm:grid-cols-3"><p>平台发布时间<br /><span className="mt-1 block font-medium">{date(note.publishedAt)}</span></p><p>读回核对时间<br /><span className="mt-1 block font-medium">{date(note.verifiedAt)}</span></p><p>最近实采时间<br /><span className="mt-1 block font-medium">{date(note.metric?.capturedAt)}</span></p></div>
    <div className="rounded-xl border border-border bg-muted/30 p-4 text-xs leading-6">
      <p className="font-medium">{evidence.gaps[0]}</p><details className="mt-1"><summary className="cursor-pointer text-muted-foreground">查看数据边界与缺口（{evidence.gaps.length}）</summary><ul className="mt-2 list-disc pl-4 text-muted-foreground">{evidence.gaps.map(g => <li key={g}>{g}</li>)}</ul></details>
    </div>
    <section className="space-y-3"><div className="flex items-center justify-between"><h2 className="text-sm font-semibold">实际回采</h2><select aria-label="曲线指标" value={field} onChange={e => setField(e.target.value as MetricField)} className={selectClass}>{METRIC_FIELDS.map(k => <option value={k} key={k}>{LABELS[k]}</option>)}</select></div>
      {evidence.metrics.length ? <><MetricTimeline label={LABELS[field]} points={evidence.metrics.map(m => ({ capturedAt: m.capturedAt, value: m[field] }))} /><SnapshotTable points={evidence.metrics} /></> : <EmptyState title="等待真实指标回采" description="保持插件及授权 API 在线，到期任务完成后这里会出现实际采样。" />}</section>
    <details className="rounded-xl border border-border p-4"><summary className="cursor-pointer text-sm font-semibold">发布内容与策划依据</summary><div className="mt-4 grid gap-5 md:grid-cols-2">
      <div><p className="text-xs text-muted-foreground">{note.contentSource === "frozen" ? "发布时冻结正文" : "当前草稿（历史原文未保存）"}</p><p className="mt-2 whitespace-pre-wrap text-sm leading-7">{evidence.content.content}</p><p className="mt-2 text-xs text-muted-foreground">{evidence.content.tags.join("、")}</p></div>
      <div className="space-y-3 text-xs leading-6"><p>发布前选题分：{n(note.planning?.score)}；流量潜力：{n(note.planning?.scoreDetail?.traffic)}</p><p>评分模型：{note.planning?.scoreModel ?? "未记录"}<br />评分时间：{date(note.planning?.scoredAt)}</p><p>封面：{evidence.cover ? `${evidence.cover.templateId} / ${evidence.cover.headline}` : "参数未保存"}</p><p>定位：{evidence.persona?.positioning || "未设置 / 历史缺失"}<br />风格：{evidence.persona?.styleNotes || "未设置 / 历史缺失"}<br />红线：{evidence.persona?.redlines || "未设置 / 历史缺失"}</p></div>
    </div></details>
    {reports.map(r => <Report key={r.id} report={r} />)}
  </div>;
}
export default function InsightsPage() {
  const { id } = useParams(), navigate = useNavigate();
  const [accountId, setAccountId] = useState(""), [horizon, setHorizon] = useState<MetricsHorizon>("latest"), [includePrivate, setIncludePrivate] = useState(false);
  const [from, setFrom] = useState(""), [to, setTo] = useState(""), [offset, setOffset] = useState(0);
  const filters = { accountId: accountId ? Number(accountId) : undefined, horizon, includePrivate: includePrivate ? "1" as const : undefined,
    from: from ? new Date(`${from}T00:00:00`).getTime() : undefined, to: to ? new Date(`${to}T23:59:59.999`).getTime() : undefined };
  const overview = useQuery({ queryKey: ["insights", filters], queryFn: () => api.insightsOverview(filters), enabled: !id, refetchInterval: 30000 });
  const notes = useQuery({ queryKey: ["insight-notes", filters, offset], queryFn: () => api.insightsNotes({ ...filters, offset }), enabled: !id, refetchInterval: 30000 });
  const accounts = useQuery({ queryKey: ["accounts", "history"], queryFn: api.accountsIncludingArchived });
  const [trendField, setTrendField] = useState<"followers" | "likesTotal" | "notesCount">("followers");
  if (id) return <NoteReview key={id} id={Number(id)} />;
  const data = overview.data;
  const reset = () => setOffset(0);
  return <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-6">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h1 className="text-xl font-semibold">看实际表现，再决定下一篇</h1><p className="mt-2 text-xs leading-6 text-muted-foreground">每篇只取一条对应快照；缺失不记为零。回采时间以浏览器实际采样为准。</p></div><Button size="sm" variant="outline" onClick={() => { void overview.refetch(); void notes.refetch(); }}><RefreshCw className="size-3.5" />刷新数据</Button></div>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border p-3">
      <select aria-label="洞察账号" value={accountId} onChange={e => { setAccountId(e.target.value); reset(); }} className={selectClass}><option value="">全部账号</option>{accounts.data?.map(a => <option key={a.id} value={a.id}>{a.nickname || a.xhsUserId}</option>)}</select>
      <select aria-label="采样窗口" value={horizon} onChange={e => { setHorizon(e.target.value as MetricsHorizon); reset(); }} className={selectClass}><option value="latest">最新快照</option><option value="1h">发布后 1–2 小时</option><option value="24h">发布后 24–48 小时</option><option value="7d">发布后 7–8 天</option></select>
      <label className="text-xs text-muted-foreground">任务创建日期 <input aria-label="起始日期" type="date" value={from} onChange={e => { setFrom(e.target.value); reset(); }} className={`${selectClass} ml-2`} /></label>
      <input aria-label="结束日期" type="date" value={to} onChange={e => { setTo(e.target.value); reset(); }} className={selectClass} />
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={includePrivate} onChange={e => { setIncludePrivate(e.target.checked); reset(); }} />包括非公开笔记</label>
    </div>
    {accounts.isError && <p role="alert" className="text-xs text-destructive">账号筛选读取失败 <button className="underline" onClick={() => void accounts.refetch()}>重试</button></p>}
    {overview.isPending ? <PageLoading label="读取回采快照…" /> : overview.isError ? <PageError error={overview.error} onRetry={() => void overview.refetch()} /> : data && <>
      <div className="flex flex-wrap gap-x-8 gap-y-4 border-b border-border pb-5 text-xs"><div><p className="text-muted-foreground">已发笔记 / 有窗口快照</p><p className="mt-2 text-lg font-semibold tabular-nums">{data.notesCount} / {data.sampledCount}</p></div>{METRIC_FIELDS.map(k => <div key={k}><p className="text-muted-foreground">{LABELS[k]}合计</p><p className="mt-2 text-lg font-semibold tabular-nums">{n(data.totals[k])}</p><p className="mt-1 text-[11px] text-muted-foreground">覆盖 {data.coverage[k]} 篇</p></div>)}</div>
      <p className="text-xs leading-6 text-muted-foreground">{data.missingMetrics} 篇待采或窗口内无数据；排除 {data.excludedPrivate} 篇非公开笔记、{data.excludedDuplicate} 条重复笔记记录。窗口是观察范围，不代表准点采样。账号趋势按快照采样日期筛选。</p>
      <section className="space-y-3"><h2 className="text-sm font-semibold">已发笔记表现（按账号分组）</h2>{notes.isPending ? <PageLoading /> : notes.isError ? <PageError error={notes.error} onRetry={() => void notes.refetch()} /> : !notes.data?.items.length ? <EmptyState title="当前范围还没有笔记表现" description="私密测试笔记可勾选“包括非公开笔记”查看；公开笔记会在真实发布和回采后出现。" /> : <>
        <div className="overflow-x-auto rounded-xl border border-border"><table className="w-full min-w-[820px] text-left text-xs"><thead className="bg-muted/40 text-muted-foreground"><tr><th className="p-3">笔记 / 账号</th><th className="p-3">发布前分数</th><th className="p-3">互动合计</th><th className="p-3">浏览 / 曝光</th><th className="p-3">实际采样</th><th className="p-3">复盘</th></tr></thead><tbody>{notes.data.items.map(note => <tr className="border-t border-border" key={note.publishJobId}><td className="max-w-64 p-3"><Link to={`/insights/${note.publishJobId}`} className="font-medium hover:underline">{note.title || "无标题"}</Link><p className="mt-1 text-muted-foreground">{note.accountName}　{note.visibility === "public" ? "公开" : "非公开"}　{note.outcome === "verified" ? "已核对" : "待核对"}</p></td><td className="p-3 tabular-nums">{n(note.planning?.score)}</td><td className="p-3 tabular-nums">{n(note.metric?.interactions)}</td><td className="p-3 tabular-nums">{n(note.metric?.views)} / {n(note.metric?.exposure)}</td><td className="p-3"><p>{date(note.metric?.capturedAt)}</p><p className="mt-1 text-muted-foreground">{note.metric ? age(note.metric.ageMs) : "等待回采"}</p></td><td className="p-3"><Button size="sm" variant="ghost" onClick={() => navigate(`/insights/${note.publishJobId}`)}>查看证据</Button></td></tr>)}</tbody></table></div>
        <div className="flex justify-end gap-3"><Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 30))}>上一页</Button><Button size="sm" variant="outline" disabled={notes.data.nextOffset === null} onClick={() => setOffset(notes.data!.nextOffset!)}>下一页</Button></div>
      </>}</section>
      <section className="space-y-3"><div className="flex items-center justify-between gap-3"><h2 className="text-sm font-semibold">账号趋势</h2><select aria-label="账号趋势指标" value={trendField} onChange={e => setTrendField(e.target.value as typeof trendField)} className={selectClass}><option value="followers">粉丝</option><option value="likesTotal">累计获赞</option><option value="notesCount">发文数</option></select></div>
        {data.accounts.length ? <div className="grid gap-5 lg:grid-cols-2">{data.accounts.map(a => <div key={a.accountId} className="rounded-xl border border-border p-4"><h3 className="mb-3 text-xs font-semibold">{a.nickname}</h3><MetricTimeline label={trendField === "followers" ? "粉丝" : trendField === "likesTotal" ? "累计获赞" : "发文数"} points={a.points.map(p => ({ capturedAt: p.capturedAt, value: p[trendField] }))} /><details className="mt-3 text-xs"><summary className="cursor-pointer text-muted-foreground">查看 {a.points.length} 次采样数值</summary><ul className="mt-2 space-y-1">{a.points.map(p => <li key={p.id}>{date(p.capturedAt)}：{n(p[trendField])}</li>)}</ul></details></div>)}</div> : <EmptyState title="账号趋势等待回采" description="在线账号的概览快照完成后显示，不用当前心跳代替历史数据。" />}</section>
      <section className="space-y-3 rounded-xl border border-border p-5"><h2 className="text-sm font-semibold">选题评分与实际表现对照</h2><p className="max-w-3xl text-xs leading-6 text-muted-foreground">{data.calibration.message}</p><p className="text-xs">当前可对照 {data.calibration.eligibleCount} 篇。{horizon === "latest" && "请选择发布后的采样窗口，避免拿不同年龄的最新快照比较。"}</p>
        {Object.entries(data.calibration.exclusions).length > 0 && <p className="text-xs leading-6 text-muted-foreground">未纳入：{Object.entries(data.calibration.exclusions).map(([reason, count]) => `${reason} ${count} 篇`).join("；")}</p>}
        {!!data.calibration.groups.length && <div className="overflow-x-auto"><table className="w-full whitespace-nowrap text-left text-xs"><thead className="text-muted-foreground"><tr><th className="py-3 pr-4">账号 / 评分模型</th><th className="pr-4">分数组 / 样本</th><th className="pr-4">流量潜力中位数</th><th className="pr-4">互动中位数</th><th className="pr-4">浏览 / 曝光中位数</th><th>实际年龄范围</th></tr></thead><tbody>{data.calibration.groups.map((g, i) => <tr key={i} className="border-t border-border"><td className="py-3 pr-4">{g.accountName}<p className="text-muted-foreground">{g.scoreModel}</p></td><td className="pr-4">{g.scoreBand} / {g.count} 篇</td><td className="pr-4">{n(g.medianTraffic)}</td><td className="pr-4">{n(g.medianInteractions)}</td><td className="pr-4">{n(g.medianViews)} / {n(g.medianExposure)}<p className="text-muted-foreground">覆盖 {g.viewsCount} / {g.exposureCount} 篇</p></td><td>{age(g.minAgeMs)}–{age(g.maxAgeMs)}</td></tr>)}</tbody></table></div>}
      </section>
    </>}
  </div>;
}
