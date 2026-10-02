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
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AiRun, Collection, HostedAccount, Topic, TopicStatus } from "@v2media/shared";
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
import { api, ApiError, captureSession, isCurrentSession } from "@/lib/api";
import { AiOperationIds, isActiveAiRun, latestTopicRun, topicRunPollInterval } from "@/lib/topic-run-flow";
import { useRuntime } from "@/lib/hooks/use-runtime";
import { fmtDateTime, timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { useWorkspaceAccount } from "@/lib/account-context";
import { useObservation } from "@/lib/hooks/use-observation";

type TopicRow = Topic;

function positiveId(value: string | null): number | null {
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function useMounted() {
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  return mounted;
}

interface TopicPrefill {
  title: string;
  angle: string;
  account?: string;
  experiment: boolean;
}

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
  prefill,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  collections: Collection[];
  accounts: HostedAccount[];
  onCreated: () => void;
  prefill?: TopicPrefill;
}) {
  const toast = useToast();
  const session = useMemo(captureSession, []);
  const mounted = useMounted();
  const { readOnly } = useRuntime();
  const workspace = useWorkspaceAccount();
  const [title, setTitle] = useState("");
  const [angle, setAngle] = useState("");
  const [collectionId, setCollectionId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [plannedAt, setPlannedAt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setTitle(prefill?.title ?? "");
      setAngle(prefill?.angle ?? "");
      const initialAccount = prefill?.account ?? (workspace.selectedAccountId === null ? "" : String(workspace.selectedAccountId));
      setAccountId(initialAccount === "" || positiveId(initialAccount) ? initialAccount : "invalid");
    }
    wasOpen.current = open;
  }, [open, prefill, workspace.selectedAccountId]);
  const accountUnavailable = !!accountId && !accounts.some(item => item.id === Number(accountId));
  const accountUnknown = workspace.status === "loading" || workspace.status === "error";

  const submit = async () => {
    if (!title.trim() || submitting || readOnly || accountUnavailable || accountUnknown) return;
    setSubmitting(true);
    try {
      const planned = plannedAt ? new Date(plannedAt).getTime() : undefined;
      await api.createTopic({
        title: title.trim(),
        angle: angle.trim() || undefined,
        collectionId: collectionId ? Number(collectionId) : undefined,
        accountId: accountId ? Number(accountId) : undefined,
        plannedAt: planned && Number.isFinite(planned) ? planned : undefined,
      }, session);
      if (!isCurrentSession(session) || !mounted.current) return;
      toast.success("选题已加入选题池");
      onCreated();
      onOpenChange(false);
      setTitle("");
      setAngle("");
      setCollectionId("");
      setAccountId("");
      setPlannedAt("");
    } catch (err) {
      if (isCurrentSession(session)) toast.error("创建失败", err instanceof Error ? err.message : undefined);
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
          {prefill?.experiment && <p className="rounded-lg border border-border bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">来自复盘的手工选题，确认后保存。以下文字可编辑，不作为已验证的分析来源。</p>}
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
                <SelectItem value="">通用风格</SelectItem>
                {accountUnavailable && <SelectItem value={accountId}>原目标账号不可用，请重新选择</SelectItem>}
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.nickname || `账号 #${a.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(accountUnknown || accountUnavailable) && <p role="alert" className="mt-2 text-xs text-destructive">{accountUnknown ? "账号状态尚未确认，暂不能保存。" : "目标账号已归档或不可访问，请明确重新选择。"}</p>}
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">计划发布时间（可选）</p>
            <Input type="datetime-local" value={plannedAt} onChange={setPlannedAt} />
          </div>
        </div>
        <div className="border-t border-border p-4">
          <Button className="w-full" disabled={!title.trim() || submitting || readOnly || accountUnavailable || accountUnknown} onClick={submit}>
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
  const session = useMemo(captureSession, []);
  const mounted = useMounted();
  const operations = useRef(new AiOperationIds());
  const { readOnly } = useRuntime();
  const workspace = useWorkspaceAccount();
  const [collectionId, setCollectionId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [count, setCount] = useState(5);
  const [submitting, setSubmitting] = useState(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) setAccountId(workspace.selectedAccountId === null ? "" : String(workspace.selectedAccountId));
    wasOpen.current = open;
  }, [open, workspace.selectedAccountId]);
  const accountUnavailable = !!accountId && !accounts.some(item => item.id === Number(accountId));
  const accountUnknown = workspace.status === "loading" || workspace.status === "error";

  const submit = async () => {
    if (!collectionId || submitting || readOnly || accountUnavailable || accountUnknown) return;
    setSubmitting(true);
    const key = JSON.stringify({ collectionId, count, accountId });
    try {
      const res = await api.aiTopics({
        collectionId: Number(collectionId),
        count,
        accountId: accountId ? Number(accountId) : undefined,
        operationId: operations.current.get(key),
      }, session);
      if (!isCurrentSession(session) || !mounted.current) return;
      operations.current.accepted(key);
      if (res.status === "done") toast.success("选题已生成");
      else if (isActiveAiRun(res)) toast.success("选题生成已排队", "进度保存在任务记录，刷新页面后可继续查看");
      else toast.info(res.status === "failed" ? "原选题任务已失败" : "原选题任务已停止", res.errorMessage ?? "请在任务记录中查看结果");
      onCreated();
      onOpenChange(false);
    } catch (err) {
      if (isCurrentSession(session)) toast.error("提交失败", err instanceof Error ? err.message : undefined);
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
                <SelectItem value="">通用风格</SelectItem>
                {accountUnavailable && <SelectItem value={accountId}>原目标账号不可用，请重新选择</SelectItem>}
                {accounts.map((a) => (
                  <SelectItem key={a.id} value={String(a.id)}>
                    {a.nickname || `账号 #${a.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {(accountUnknown || accountUnavailable) && <p role="alert" className="mt-2 text-xs text-destructive">{accountUnknown ? "账号状态尚未确认，暂不能生成。" : "目标账号已归档或不可访问，请明确重新选择。"}</p>}
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
          <Button className="w-full" disabled={!collectionId || submitting || readOnly || accountUnavailable || accountUnknown} onClick={submit}>
            {submitting ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            开始生成
          </Button>
        </div>
      </div>
    </Drawer>
  );
}

/** 选题详情抽屉：评分雷达（横条）+ 深评 + 操作。 */
function AiRunNotice({ run, onChanged }: { run: AiRun; onChanged: () => void }) {
  const toast = useToast();
  const session = useMemo(captureSession, []);
  const operations = useRef(new AiOperationIds());
  const { readOnly } = useRuntime();
  const [busy, setBusy] = useState(false);
  const labels = { queued: run.nextAttemptAt ? "等待恢复" : "排队中", running: "进行中", done: "已完成", failed: "失败", canceled: "已停止" };
  const control = async (action: "retry" | "cancel") => {
    if (busy || readOnly) return;
    setBusy(true);
    try {
      const key = `retry:${run.id}:${run.attempt}`;
      if (action === "retry") await api.retryAiRun(run.id, { operationId: operations.current.get(key) }, session);
      else await api.cancelAiRun(run.id, session);
      if (!isCurrentSession(session)) return;
      onChanged();
    } catch (error) {
      if (isCurrentSession(session)) toast.error("任务操作失败", error instanceof Error ? error.message : undefined);
    } finally { setBusy(false); }
  };
  return (
    <div className="rounded-xl border border-border bg-background p-3 text-xs" role="status">
      <div className="flex flex-wrap items-center gap-2">
        {isActiveAiRun(run) && <Loader2 className="size-3.5 animate-spin text-primary" />}
        <span className="font-medium">{run.kind === "topic_generate" ? "选题生成" : "选题深评"} · {labels[run.status]}</span>
        <span className="text-muted-foreground">#{run.id} · {run.attempt ? `第 ${run.attempt} 次执行` : "等待开始"}</span>
        {!readOnly && <span className="ml-auto flex items-center gap-2">
          {run.status === "failed" && <button className="text-primary disabled:opacity-50" disabled={busy} onClick={() => void control("retry")}>重试原任务</button>}
          {isActiveAiRun(run) && <button className="text-muted-foreground disabled:opacity-50" disabled={busy} onClick={() => void control("cancel")}>取消</button>}
        </span>}
      </div>
      {run.errorMessage && <p className="mt-2 leading-5 text-muted-foreground">{run.errorMessage}</p>}
      {isActiveAiRun(run) && run.progress?.steps?.length ? <p className="mt-2 leading-5 text-muted-foreground">{run.progress.steps.at(-1)}</p> : null}
      {run.status === "done" && run.result && "count" in run.result && <p className="mt-2 text-muted-foreground">已生成 {run.result.count} 个选题并写入选题池</p>}
    </div>
  );
}

function TopicDetailDrawer({
  topic,
  onClose,
  onChanged,
  runs,
}: {
  topic: TopicRow | null;
  onClose: () => void;
  onChanged: () => void;
  runs: AiRun[];
}) {
  const toast = useToast();
  const session = useMemo(captureSession, []);
  const mounted = useMounted();
  const operations = useRef(new AiOperationIds());
  const { readOnly } = useRuntime();
  const navigate = useNavigate();
  const [scoring, setScoring] = useState(false);
  const scoreRun = topic ? latestTopicRun(runs, "topic_score", topic.id) : undefined;
  const scoreResult = scoreRun?.status === "done" && scoreRun.result && "verdict" in scoreRun.result
    && topic?.scoreMethod && topic.score === scoreRun.result.score ? scoreRun.result : null;
  const verdict = scoreResult?.verdict ?? "";
  const advice = scoreResult?.advice ?? "";
  const [busy, setBusy] = useState(false);

  const runScore = async () => {
    if (!topic || scoring || readOnly || (scoreRun && isActiveAiRun(scoreRun))) return;
    setScoring(true);
    try {
      const key = `score:${topic.id}:${topic.updatedAt}`;
      const run = await api.aiTopicScore({ topicId: topic.id, operationId: operations.current.get(key) }, session);
      if (!isCurrentSession(session)) return;
      operations.current.accepted(key);
      if (isActiveAiRun(run)) toast.success("深评已排队", "可关闭抽屉，完成后评分自动更新");
      else toast.info(run.status === "done" ? "原深评任务已完成" : "原深评任务已停止", run.errorMessage ?? undefined);
      onChanged();
    } catch (err) {
      if (isCurrentSession(session)) toast.error("深评提交失败", err instanceof Error ? err.message : undefined);
    } finally {
      setScoring(false);
    }
  };

  const toDraft = async (ai = true) => {
    if (!topic || busy || readOnly || topic.status === "archived") return;
    setBusy(true);
    try {
      const res = await api.topicToDraft(topic.id, { ai }, session);
      if (!isCurrentSession(session) || !mounted.current) return;
      toast.success(res.jobId ? "开始成稿和封面生成" : "已转入草稿工坊", res.draft.title || undefined);
      onChanged();
      navigate(`/drafts/${res.draft.id}`);
    } catch (err) {
      if (isCurrentSession(session)) toast.error("转草稿失败", err instanceof Error ? err.message : undefined);
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
            <nav aria-label="选题关联内容" className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-primary">
              {topic.collectionId && <Link to={`/library?col=${topic.collectionId}`}>来源采集库</Link>}
              {topic.sourceNoteId && <Link to={`/library?note=${topic.sourceNoteId}`}>来源笔记</Link>}
              {topic.analysisSource && <Link to={`/analysis?col=${topic.analysisSource.collectionId}&report=${topic.analysisSource.analysisId}`}>来源分析报告</Link>}
              {topic.accountId && <Link to={`/accounts?account=${topic.accountId}`}>目标账号</Link>}
              {topic.draftId && <Link to={`/drafts/${topic.draftId}`}>已关联草稿</Link>}
              {topic.publishJobId && <Link to={`/publish?job=${topic.publishJobId}`}>发布任务</Link>}
            </nav>
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
            {scoreRun && <AiRunNotice run={scoreRun} onChanged={onChanged} />}
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
            <Button className="w-full" onClick={() => void toDraft(true)} disabled={busy || readOnly || topic.status === "published" || topic.status === "archived"}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <NotebookPen className="size-4" />}
              {topic.draftId ? "打开已关联草稿" : "一键成稿 · 自动带封面"}
            </Button>
            {!topic.draftId && <Button variant="ghost" className="w-full" onClick={() => void toDraft(false)} disabled={busy || readOnly || topic.status === "archived"}>转入草稿自行编辑</Button>}
            <Button variant="ghost" className="w-full" onClick={runScore} disabled={scoring || readOnly || topic.status === "archived" || !!(scoreRun && isActiveAiRun(scoreRun))}>
              {scoring || (scoreRun && isActiveAiRun(scoreRun)) ? <Loader2 className="size-4 animate-spin" /> : <Target className="size-4" />}
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
  const session = useMemo(captureSession, []);
  const { readOnly } = useRuntime();
  const observation = useObservation();
  const [params, setParams] = useSearchParams();
  const rawStatus = params.get("status") ?? "";
  const statusValid = params.getAll("status").length <= 1 && STATUS_TABS.some(tab => tab.value === rawStatus);
  const status = statusValid ? rawStatus : "";
  const topicId = params.getAll("topic").length === 1 ? positiveId(params.get("topic")) : null;
  const topicRequested = params.has("topic");
  const [newOpen, setNewOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const prefill = useMemo<TopicPrefill | undefined>(() => params.get("new") === "1" ? {
    title: (params.get("title") ?? "").slice(0, 512),
    angle: (params.get("angle") ?? "").slice(0, 4000),
    account: params.has("account") ? (params.getAll("account").length === 1 && positiveId(params.get("account")) ? params.get("account")! : "invalid") : undefined,
    experiment: params.has("experimentFrom"),
  } : undefined, [params]);
  useEffect(() => { if (prefill) setNewOpen(true); }, [prefill]);
  const setFilter = (next: string) => setParams(current => {
    const updated = new URLSearchParams(current);
    if (next) updated.set("status", next); else updated.delete("status");
    return updated;
  });
  const selectTopic = (id: number | null) => setParams(current => {
    const updated = new URLSearchParams(current);
    if (id !== null) updated.set("topic", String(id)); else updated.delete("topic");
    return updated;
  });
  const closeNew = (open: boolean) => {
    setNewOpen(open);
    if (!open && prefill) setParams(current => {
      const updated = new URLSearchParams(current);
      for (const key of ["new", "title", "angle", "account", "experimentFrom", "report"]) updated.delete(key);
      return updated;
    }, { replace: true });
  };

  const topicsQuery = useQuery({
    queryKey: ["topics", status],
    queryFn: () => api.topics(status || undefined),
  });
  const collectionsQuery = useQuery({ queryKey: ["collections"], queryFn: api.collections });
  const accountsQuery = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const topicQuery = useQuery({ queryKey: ["topic", topicId],
    queryFn: () => api.topic(topicId!, session), enabled: topicId !== null });
  const inaccessibleTopic = topicQuery.error instanceof ApiError && topicQuery.error.status === 404;
  const selected = !inaccessibleTopic && topicQuery.data?.id === topicId ? topicQuery.data : null;

  const generationRuns = useQuery({ queryKey: ["ai-runs", "topic_generate"],
    queryFn: () => api.aiRuns({ kind: "topic_generate" }, session),
    refetchInterval: query => observation.interval(topicRunPollInterval(query.state.data?.items) !== false, 2000, false, query.state.fetchFailureCount) });
  const scoreRuns = useQuery({ queryKey: ["ai-runs", "topic_score"],
    queryFn: () => api.aiRuns({ kind: "topic_score" }, session),
    refetchInterval: query => observation.interval(topicRunPollInterval(query.state.data?.items) !== false, 2000, false, query.state.fetchFailureCount) });
  const runs = useMemo(() => [...(generationRuns.data?.items ?? []), ...(scoreRuns.data?.items ?? [])].sort((a, b) => b.id - a.id), [generationRuns.data, scoreRuns.data]);
  const completed = runs.filter(run => run.status === "done").map(run => `${run.id}:${run.attempt}`).join(",");
  useEffect(() => { if (completed) {
    void queryClient.invalidateQueries({ queryKey: ["topics"] });
    void queryClient.invalidateQueries({ queryKey: ["topic"] });
  } }, [completed, queryClient]);

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["topics"] });
    void queryClient.invalidateQueries({ queryKey: ["topic"] });
    void queryClient.invalidateQueries({ queryKey: ["ai-runs"] });
  };

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
    <div className="workspace-page space-y-5">
      <header><h1 className="workspace-page-title">为下一篇选个方向</h1><p className="mt-2 text-sm text-muted-foreground">把灵感、样本依据和账号匹配放在一起，再决定先写哪一篇。</p></header>
      <div className="flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((t) => (
          <button
            key={t.value}
            onClick={() => setFilter(t.value)}
            className={cn(
              "rounded-lg px-3 py-1.5 text-xs transition-colors",
              status === t.value
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-muted/70",
            )}
          >
            {t.label}
          </button>
        ))}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={() => setAiOpen(true)} disabled={!collections.length || readOnly}>
            <Sparkles className="size-4" />
            AI 生成选题
          </Button>
          <Button size="sm" onClick={() => setNewOpen(true)} disabled={readOnly}>
            <Plus className="size-4" />
            新建选题
          </Button>
        </div>
      </div>

      {!statusValid && <p role="alert" className="rounded-lg border border-border p-3 text-xs text-muted-foreground">选题筛选参数无效。<button className="ml-2 text-primary" onClick={() => setFilter("")}>查看全部</button></p>}
      {topicRequested && (topicId === null || topicQuery.isError) && <p role="alert" className="rounded-lg border border-border p-3 text-xs text-muted-foreground">{topicId === null || (topicQuery.error instanceof ApiError && topicQuery.error.status === 404) ? "无法访问这条选题，地址无效或选题不属于当前用户。" : "指定选题暂时无法读取，结果未知；可重试读取。"}<button className="ml-2 text-primary" onClick={() => selectTopic(null)}>移除地址参数</button>{topicId !== null && topicQuery.isError && <button className="ml-2 text-primary" onClick={() => void topicQuery.refetch()}>重试</button>}</p>}
      {topicId !== null && topicQuery.isPending && <p role="status" className="text-xs text-muted-foreground">正在读取指定选题…</p>}

      {(generationRuns.isError || scoreRuns.isError) && <p role="alert" className="rounded-xl border border-border p-3 text-xs text-muted-foreground">任务记录暂时无法读取，结果未知；连接恢复后刷新查看。</p>}
      {!!runs.length && <section className="space-y-2" aria-label="AI 任务记录">
        <p className="text-xs font-medium text-muted-foreground">AI 任务 · 进度保存在服务器，可离开页面后继续查看</p>
        {runs.filter((run, index) => isActiveAiRun(run) || index < 3).map(run => <AiRunNotice key={run.id} run={run} onChanged={refresh} />)}
      </section>}

      {!items.length ? (
        <EmptyState
          icon={Lightbulb}
          title={status ? "这个状态下还没有选题" : "选题池还是空的"}
          description="手填一个方向，或让 AI 从采集库里的爆款帮你生成"
          action={
            <Button variant="ghost" onClick={() => setAiOpen(true)} disabled={!collections.length || readOnly}>
              <Sparkles className="size-4" />
              AI 生成选题
            </Button>
          }
        />
      ) : (
        <div className="workspace-panel divide-y divide-border overflow-hidden">
          {items.map((t) => (
            <button
              key={t.id}
              onClick={() => selectTopic(t.id)}
              className="group block w-full px-5 py-4 text-left transition-colors hover:bg-muted/30"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{t.title}</p>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                    {t.angle || "（无切入角度）"}
                  </p>
                </div>
                {t.score != null && (
                  <span className={cn("grid size-9 shrink-0 place-items-center rounded-full text-sm font-semibold tabular-nums ring-2 ring-current/25", scoreTone(t.score))}>
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
                {!readOnly && <span className="ml-auto flex gap-1 opacity-0 transition-opacity group-hover:opacity-100">
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
                </span>}
              </div>
            </button>
          ))}
        </div>
      )}

      <NewTopicDrawer
        key={prefill ? JSON.stringify(prefill) : "manual"}
        open={newOpen}
        onOpenChange={closeNew}
        collections={collections}
        accounts={accounts}
        onCreated={refresh}
        prefill={prefill}
      />
      <AiTopicsDrawer
        open={aiOpen}
        onOpenChange={setAiOpen}
        collections={collections}
        accounts={accounts}
        onCreated={refresh}
      />
      <TopicDetailDrawer
        key={selected?.id ?? "closed"}
        topic={selected}
        onClose={() => selectTopic(null)}
        onChanged={refresh}
        runs={runs}
      />
    </div>
  );
}
