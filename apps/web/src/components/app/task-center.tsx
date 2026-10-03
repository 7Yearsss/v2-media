import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowUpRight, Check, Clock3, Loader2, Pause, RefreshCw, TriangleAlert, X } from "lucide-react";
import type { WorkspaceTask, WorkspaceTaskFilter } from "@v2media/shared";
import { Drawer } from "@/components/motion/drawer";
import { Button } from "@/components/motion/button";
import { useTaskCenter } from "@/lib/hooks/use-task-center";
import { fmtDateTime, timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";

const labels: Record<WorkspaceTask["state"], string> = { queued: "等待处理", running: "处理中", paused: "已暂停", blocked: "需处理",
  partial: "部分完成", done: "已完成", failed: "失败", canceled: "已取消", unknown: "结果未知" };
const filters: Array<{ value: WorkspaceTaskFilter; label: string }> = [{ value: "active", label: "进行中" }, { value: "attention", label: "需关注" }, { value: "all", label: "全部" }];
const nextLabels = { scheduled: "计划执行", retry: "再次处理", lease: "执行有效期" };

function TaskRow({ task, onNavigate }: { task: WorkspaceTask; onNavigate: () => void }) {
  const alert = task.bucket === "attention";
  const Icon = alert ? TriangleAlert : task.state === "running" ? Loader2 : task.state === "done" ? Check : task.state === "paused" ? Pause : Clock3;
  return <li className="border-b border-border px-5 py-4 last:border-0">
    <div className="flex items-start gap-3">
      <div className={cn("mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground", alert && "bg-amber-500/10 text-amber-700 dark:text-amber-400")}>
        <Icon className={cn("size-3.5", task.state === "running" && "motion-safe:animate-spin")} aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-[13px] font-medium">{task.label}</span>
          <span className={cn("text-[11px] text-muted-foreground", alert && "text-amber-700 dark:text-amber-400")}>{labels[task.state]}</span>
          <span className="ml-auto text-[11px] text-muted-foreground" title={fmtDateTime(task.updatedAt)}>{timeAgo(task.updatedAt)}</span>
        </div>
        <p className="mt-1 truncate text-[13px]" title={task.object?.title}>{task.object?.title ?? (task.kind === "media_store" ? "采集素材" : "关联内容已移除或未指定")}{task.object?.archived && <span className="ml-1 text-[11px] text-muted-foreground">已归档</span>}</p>
        {(["unknown", "failed", "blocked", "partial"].includes(task.state) || task.nextCheckKind === "scheduled" || task.description.includes("失效")) && <p className="mt-1 text-xs leading-5 text-muted-foreground">{task.state === "unknown" && task.source === "publish" ? "请先核对站点，勿直接重发。" : task.description}</p>}
        {task.state === "running" && <p className="mt-1 text-xs text-muted-foreground">{task.stage}</p>}
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          {task.object?.type !== "account" && <span>{task.account ? `${task.account.nickname}${task.account.archived ? " · 已归档" : ""}` : "未绑定账号"}</span>}
          <span title={`原始状态：${task.rawStatus}`}>#{task.id}</span>
          {task.nextCheckAt && task.nextCheckKind && <span>{nextLabels[task.nextCheckKind]} {fmtDateTime(task.nextCheckAt)}</span>}
        </div>
        <Link to={task.href} onClick={onNavigate} className="mt-2 inline-flex items-center gap-1 rounded text-xs font-medium text-foreground underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-ring">{task.actionLabel}<ArrowUpRight className="size-3" aria-hidden /></Link>
      </div>
    </div>
  </li>;
}

export interface TaskCenterProps { open: boolean; onOpenChange: (open: boolean) => void; accountId?: number | null }
export function TaskCenter({ open, onOpenChange, accountId }: TaskCenterProps) {
  const [filter, setFilter] = useState<WorkspaceTaskFilter>("active");
  const query = useTaskCenter(open, { filter, accountId });
  const data = query.data;
  return <Drawer open={open} onOpenChange={onOpenChange} ariaLabel="任务中心" showCloseButton={false} className="w-[480px] max-w-full bg-card" backdropClassName="bg-black/20 backdrop-blur-none">
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-5 py-4">
        <div className="min-w-0 flex-1"><h2 className="text-base font-semibold">任务</h2><p className="mt-1 text-xs text-muted-foreground">{accountId ? "当前账号" : "全部账号"}</p></div>
        <Button size="icon" variant="ghost" aria-label="刷新任务" disabled={!query.available || query.isFetching} onClick={() => void query.refetch()}><RefreshCw className={cn("size-4", query.isFetching && "motion-safe:animate-spin")} /></Button>
        <button data-dialog-autofocus type="button" aria-label="关闭任务中心" onClick={() => onOpenChange(false)} className="flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring"><X className="size-4" /></button>
      </header>
      <div className="flex shrink-0 gap-1 border-b border-border px-5 py-3" aria-label="任务状态筛选">
        {filters.map(item => <button type="button" key={item.value} onClick={() => setFilter(item.value)} aria-pressed={filter === item.value} className={cn("rounded-md px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring", filter === item.value && "bg-muted font-medium text-foreground")}>
          {item.label}{data && <span className="ml-1.5 tabular-nums">{item.value === "all" ? data.counts.active + data.counts.attention + data.counts.completed : data.counts[item.value]}</span>}
        </button>)}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {!query.available && <p role="status" className="border-b border-border px-5 py-3 text-xs text-muted-foreground">当前离线或页面不可见，自动刷新已暂停。恢复后重新读取状态。</p>}
        {query.isError && <div role="alert" className="border-b border-border px-5 py-4 text-xs text-destructive">任务读取失败{data ? "，下方保留上次读取结果。" : "。"}<button type="button" disabled={!query.available} onClick={() => void query.refetch()} className="ml-2 underline">重试读取</button></div>}
        {query.isPending && !query.isError && query.available && <p className="flex items-center gap-2 px-5 py-8 text-xs text-muted-foreground"><Loader2 className="size-3.5 motion-safe:animate-spin" />正在读取任务</p>}
        {data && <>
          {data.truncated && <p className="border-b border-border bg-muted/50 px-5 py-3 text-xs leading-5 text-muted-foreground">当前展示 {data.items.length} 项。每种任务来源、每个状态组最多显示最近 {data.perSourceBucketLimit} 项；还有较早任务，请到关联页面查看。</p>}
          {data.items.length ? <ul>{data.items.map(task => <TaskRow key={task.key} task={task} onNavigate={() => onOpenChange(false)} />)}</ul> : <p className="px-5 py-10 text-center text-xs text-muted-foreground">{filter === "active" ? "当前没有进行中或暂停的任务" : filter === "attention" ? "当前没有需要关注的任务" : "当前没有任务"}</p>}
        </>}
      </div>
      <footer className="shrink-0 border-t border-border px-5 py-3 text-[11px] leading-5 text-muted-foreground">
        {data && <p>更新于 {fmtDateTime(data.observedAt)}</p>}
      </footer>
    </div>
  </Drawer>;
}
