import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Plus, Search, X } from "lucide-react";
import { COLLECTION_CAPABILITY, type CollectionTask, type CollectionControlRequest } from "@v2media/shared";
import { api } from "@/lib/api";
import { bridge } from "@/lib/bridge";
import { useToast } from "@/lib/toast";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { cn } from "@/lib/utils";
import { useObservation } from "@/lib/hooks/use-observation";
import { useRuntime } from "@/lib/hooks/use-runtime";
const STATUS: Record<CollectionTask["status"], string> = { queued: "等待插件", running: "正在采集", paused: "已暂停", blocked: "需要处理登录 / 验证", done: "已完成", partial: "部分完成", failed: "失败", canceled: "已取消" };
const COVERAGE: Record<string, string> = { not_requested: "未要求采评", none: "确认无评论", partial: "部分采集", complete: "已核对完整" };
const field = "rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";
const number = (n: number | null) => n === null ? "未采到" : String(n);

function TaskDetail({ id }: { id: number }) {
  const [offset, setOffset] = useState(0);
  const { interval } = useObservation();
  const detail = useQuery({ queryKey: ["collection-task", id, offset], queryFn: () => api.collectionTask(id, offset), refetchInterval: q => interval(!!q.state.data && ["queued", "running"].includes(q.state.data.task.status), 3000, false, q.state.fetchFailureCount) });
  if (detail.isPending) return <PageLoading />;
  if (detail.isError) return <PageError error={detail.error} onRetry={() => void detail.refetch()} />;
  const { task, items, nextOffset } = detail.data;
  return <div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
    <div className="flex flex-wrap justify-between gap-2"><h2 className="text-sm font-semibold">采集明细 #{id}　{task.keyword}</h2><span className="text-xs text-muted-foreground">{task.phase === "search" ? "搜索发现" : "详情与评论"} / 已滚动 {task.scrollSteps} 次</span></div>
    <details className="text-xs leading-6 text-muted-foreground"><summary className="cursor-pointer">任务规则 · {task.collectionName}</summary><p className="mt-2">点赞 ≥ {task.minLikes}；扫描 ≤ {task.scanLimit}；入库 ≤ {task.saveLimit}；每篇评论与回复 ≤ {task.commentLimit}；间隔 {task.intervalMs / 1000} 秒。重试沿用此规则。</p></details>
    <p className="text-xs leading-6">{task.reason ?? "等待浏览器执行"} {task.status === "running" && task.leaseUntil && Date.parse(task.leaseUntil) < Date.now() ? "连接已过期，插件上线后从已保存进度继续。" : ""}</p>
    {items.length ? <div className="overflow-x-auto"><table className="w-full min-w-[680px] text-left text-xs"><thead className="text-muted-foreground"><tr><th className="py-3 pr-3">笔记 / 点赞</th><th className="pr-3">详情入库</th><th className="pr-3">平台评论</th><th className="pr-3">实采主评 / 回复</th><th>评论覆盖 / 原因</th></tr></thead><tbody>{items.map(i => <tr className="border-t border-border" key={i.id}><td className="max-w-64 py-3 pr-3"><p className="truncate font-medium">{i.title || "无标题"}</p><p className="mt-1 text-muted-foreground">点赞 {i.likes}</p></td><td className="pr-3">{i.collectedNoteId ? i.alreadyExisted ? "更新已有笔记" : "已新增入库" : i.status === "skipped" ? "已跳过" : i.status === "failed" ? "失败" : "待采详情"}</td><td className="pr-3 tabular-nums">{number(i.platformComments)}</td><td className="pr-3 tabular-nums">{i.capturedComments} / {i.capturedReplies}</td><td className="max-w-60 text-muted-foreground"><p>{COVERAGE[i.commentCoverage]}</p><p className="mt-1 leading-5">{i.reason}</p></td></tr>)}</tbody></table></div> : <EmptyState title="等待发现笔记" />}
    <div className="flex justify-end gap-2"><Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 50))}>上一页</Button><Button size="sm" variant="outline" disabled={nextOffset === null} onClick={() => setOffset(nextOffset!)}>下一页</Button></div>
  </div>;
}
export default function CollectionTasksPage() {
  const client = useQueryClient(), toast = useToast();
  const { interval } = useObservation(), { readOnly } = useRuntime();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedParam = searchParams.get("task"), selectedNumber = Number(selectedParam);
  const selected = selectedParam && Number.isSafeInteger(selectedNumber) && selectedNumber > 0 ? selectedNumber : null;
  const setSelected = (id: number) => { const next = new URLSearchParams(searchParams); next.set("task", String(id)); setSearchParams(next); };
  const [keyword, setKeyword] = useState(""), [collectionId, setCollectionId] = useState(""), [busy, setBusy] = useState<string | null>(null);
  const [limits, setLimits] = useState({ minLikes: 1000, scanLimit: 60, saveLimit: 10, commentLimit: 50, interval: 5 });
  const tasks = useQuery({ queryKey: ["collection-tasks"], queryFn: api.collectionTasks, refetchInterval: q => interval(!!q.state.data?.items.some(task => ["queued", "running"].includes(task.status)), 3000, false, q.state.fetchFailureCount) });
  const collections = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const extension = useQuery({ queryKey: ["extension-capabilities"], queryFn: bridge.info, retry: false, refetchInterval: () => interval(true, 12000) });
  const ready = extension.data?.authorized && extension.data.capabilities?.includes(COLLECTION_CAPABILITY);
  const refresh = async () => { await client.invalidateQueries({ queryKey: ["collection-tasks"] }); await client.invalidateQueries({ queryKey: ["collection-task"] }); };
  const wake = () => { if (ready) void bridge.wakeCollectionTasks().catch(() => {}); };
  const create = async () => { if (busy || readOnly) return; setBusy("create");
    try { const { interval, ...rules } = limits; const task = await api.createCollectionTask({ keyword, collectionId: Number(collectionId), ...rules, intervalMs: interval * 1000 });
      setSelected(task.id); await refresh(); wake(); toast.success("采集任务已排队", ready ? "插件会在发布与回采之后执行" : "连接并授权新版插件后开始执行"); }
    catch (e) { toast.error("创建任务失败", e instanceof Error ? e.message : undefined); } finally { setBusy(null); } };
  const control = async (task: CollectionTask, action: CollectionControlRequest["action"]) => { if (busy || readOnly) return; setBusy(`${task.id}:${action}`);
    try { await api.controlCollectionTask(task.id, { revision: task.revision, action }); await refresh(); wake(); toast.success(action === "pause" ? "任务已暂停" : action === "cancel" ? "任务已取消" : "任务已重新排队"); }
    catch (e) { toast.error("操作失败", e instanceof Error ? e.message : undefined); await refresh(); } finally { setBusy(null); } };
  return <div className="workspace-page space-y-5">
    <header><h1 className="workspace-page-title">自动采集</h1></header>
    {!ready && <div className="rounded-xl border border-border bg-muted/30 p-3 text-xs leading-6">{extension.data && !extension.data.capabilities?.includes(COLLECTION_CAPABILITY) ? `插件 ${extension.data.version} 不支持此任务，请更新至 0.1.8 或更新版本。` : "插件未就绪，可先保存任务。"} <a href="/extension" className="font-medium text-primary underline">连接插件</a></div>}
    <section className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5"><h2 className="text-sm font-semibold">新建任务</h2><div className="grid gap-4 sm:grid-cols-2"><label className="space-y-2 text-xs">搜索关键词<Input aria-label="搜索关键词" placeholder="例如：下班备餐" maxLength={80} value={keyword} onChange={setKeyword} /></label><label className="space-y-2 text-xs">目标采集库<select aria-label="目标采集库" className={`${field} block w-full`} value={collectionId} onChange={e => setCollectionId(e.target.value)}><option value="">选择采集库</option>{collections.data?.items.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label></div>
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">{[
        { key: "minLikes", label: "最低点赞", min: 0, max: 10000000 }, { key: "scanLimit", label: "扫描上限", min: 1, max: 300 },
        { key: "saveLimit", label: "入库上限", min: 1, max: 30 }, { key: "commentLimit", label: "每篇评论上限（含回复）", min: 0, max: 200 }, { key: "interval", label: "操作间隔（秒）", min: 2, max: 15 },
      ].map(f => <label key={f.key} className="space-y-2 text-xs">{f.label}<Input aria-label={f.label} type="number" min={f.min} max={f.max} value={String(limits[f.key as keyof typeof limits])} onChange={value => setLimits(cur => ({ ...cur, [f.key]: Number(value) }))} /></label>)}</div>
      {collections.isError && <PageError error={collections.error} onRetry={() => void collections.refetch()} />}
      <div className="flex flex-wrap items-center justify-between gap-3"><details className="text-xs text-muted-foreground"><summary className="cursor-pointer">执行规则</summary><p className="mt-2 max-w-lg leading-6">浏览器在线时执行；登录失效或验证时暂停，不绕过验证。最多 10 个未结束任务，发布和到期回采优先。搜索与评论均受上限约束，不保证全量采集。</p></details><Button size="sm" disabled={readOnly || !!busy || !keyword.trim() || !collectionId} onClick={() => void create()}><Plus className="size-4" />{busy === "create" ? "保存中…" : "创建任务"}</Button></div>
    </section>
    <section className="space-y-3"><h2 className="text-sm font-semibold">最近 50 个任务</h2>{tasks.isPending ? <PageLoading /> : tasks.isError ? <PageError error={tasks.error} onRetry={() => void tasks.refetch()} /> : !tasks.data.items.length ? <EmptyState icon={Search} title="暂无采集任务" /> : <div className="space-y-2">{tasks.data.items.map(task => <div key={task.id} className={cn("flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4", selected === task.id ? "border-primary bg-primary/5" : "border-border bg-card")}><button onClick={() => setSelected(task.id)} className="min-w-0 flex-1 space-y-2 text-left"><p className="text-sm font-semibold">#{task.id}　{task.keyword}<span className="ml-3 text-xs font-normal text-muted-foreground">{STATUS[task.status]}</span></p><p className="text-xs leading-6 text-muted-foreground">发现 {task.counts.discovered}/{task.scanLimit}　跳过 {task.counts.skipped}　入库 {task.counts.saved}/{task.saveLimit}（新增 {task.counts.newNotes}）　待详情 {task.counts.pending}　失败 {task.counts.failed}　评论部分 {task.counts.partial}　主评/回复 {task.counts.comments}/{task.counts.replies}</p><p className="text-xs text-muted-foreground">{task.reason ?? task.collectionName}</p></button><div className="flex gap-2">{["queued", "running"].includes(task.status) && <Button size="sm" variant="outline" disabled={readOnly || !!busy} onClick={() => void control(task, "pause")}><Pause className="size-3.5" />暂停</Button>}{["paused", "blocked", "failed", "partial"].includes(task.status) && <Button size="sm" variant="outline" disabled={readOnly || !!busy} onClick={() => void control(task, "resume")}><Play className="size-3.5" />{task.status === "blocked" ? "已处理，继续" : "继续"}</Button>}{!["done", "canceled"].includes(task.status) && <Button size="sm" variant="ghost" disabled={readOnly || !!busy} onClick={() => void control(task, "cancel")}><X className="size-3.5" />取消</Button>}</div></div>)}</div>}</section>
    {selected !== null && <TaskDetail key={selected} id={selected} />}
    {selectedParam && selected === null && <p role="alert" className="text-sm text-destructive">采集任务地址无效，请从任务列表选择。</p>}
  </div>;
}
