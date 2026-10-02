import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/motion/button";
import { api, captureSession, isCurrentSession } from "@/lib/api";
import { useRuntime } from "@/lib/hooks/use-runtime";
import { useToast } from "@/lib/toast";
import { useObservation } from "@/lib/hooks/use-observation";

const labels = { queued: "等待处理", running: "正在分析", done: "已完成", failed: "分析已停止", canceled: "已取消" };
export function AiRunStatus({ id, onChange }: { id: number; onChange: () => void }) {
  const session = useMemo(captureSession, []), client = useQueryClient(), toast = useToast(), { readOnly } = useRuntime();
  const { interval } = useObservation();
  const retryId = useRef<{ attempt: number; id: string } | null>(null), [busy, setBusy] = useState(false);
  const query = useQuery({ queryKey: ["ai-run", id], queryFn: () => api.aiRun(id, session), refetchInterval: q => interval(!!q.state.data && ["queued", "running"].includes(q.state.data.status), 2000, false, q.state.fetchFailureCount) });
  const run = query.data;
  const action = async (retry: boolean) => {
    if (busy || readOnly || !run) return; setBusy(true);
    try {
      if (retry) {
        if (retryId.current?.attempt !== run.attempt) retryId.current = { attempt: run.attempt, id: crypto.randomUUID() };
        await api.retryAiRun(id, { operationId: retryId.current.id }, session); retryId.current = null;
      }
      else await api.cancelAiRun(id, session);
      if (!isCurrentSession(session)) return;
      await client.invalidateQueries({ queryKey: ["ai-run", id] }); await client.invalidateQueries({ queryKey: ["ai-runs"] }); onChange();
    } catch (error) { if (isCurrentSession(session)) toast.error(retry ? "重试未确认" : "停止失败", error instanceof Error ? error.message : undefined); }
    finally { if (isCurrentSession(session)) setBusy(false); }
  };
  if (query.isError) return <p role="alert" className="text-xs text-destructive">任务状态读取失败 <button className="underline" onClick={() => void query.refetch()}>重试读取</button></p>;
  if (!run || run.status === "done") return null;
  return <div className="workspace-panel flex flex-wrap items-center gap-3 px-4 py-3 text-xs">
    <span className="flex items-center gap-2 font-medium">{["queued", "running"].includes(run.status) && <Loader2 className="size-3.5 animate-spin" />}{labels[run.status]}</span>
    <span className="min-w-0 flex-1 text-muted-foreground">{run.errorMessage || (run.status === "queued" ? "任务已保存，页面刷新后可以继续查看" : "按创建时的资料与账号设置处理")}</span>
    {run.status === "failed" && <Button size="sm" variant="outline" disabled={busy || readOnly} onClick={() => void action(true)}>按原输入重试</Button>}
    {["queued", "running"].includes(run.status) && <Button size="sm" variant="ghost" disabled={busy || readOnly} onClick={() => void action(false)}>停止本次分析</Button>}
  </div>;
}
