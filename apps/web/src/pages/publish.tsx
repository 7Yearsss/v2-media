import {
  ExternalLink,
  Play,
  Plus,
  RotateCcw,
  SendHorizontal,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BANNED_KIND_META, checkBannedWords, checkDraftLimits, summarizeBanned } from "@v2media/shared";
import { useBannedWords } from "@/lib/hooks/use-banned-words";
import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Draft,
  HostedAccount,
  PublishJob,
  PublishJobCreateRequest,
} from "@v2media/shared";
import { ApprovalCard } from "@/components/agents/approval-card";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { Drawer } from "@/components/motion/drawer";
import { RadioGroup, RadioGroupItem } from "@/components/motion/radio";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/motion/select";
import { Table, type TableColumn } from "@/components/motion/table";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { api, captureSession, isCurrentSession, mediaUrl } from "@/lib/api";
import { useRuntime } from "@/lib/hooks/use-runtime";
import { useWorkspaceAccount } from "@/lib/account-context";
import { useObservation } from "@/lib/hooks/use-observation";
import { ContentLinks } from "@/components/app/content-links";
import { bridge } from "@/lib/bridge";
import { comparePublishVersion, publishVersionLabels, selectOriginalRetry, submitOriginalRetry, type RetrySelection } from "@/lib/publish-version";
import {
  fmtDateTime,
  JOB_STATUS_META,
  timeAgo,
  VISIBILITY_LABEL,
} from "@/lib/format";
import { useToast } from "@/lib/toast";

type JobRow = PublishJob & { draftTitle: string; accountName: string };
type PublishSeed = Partial<Pick<PublishJobCreateRequest, "draftId" | "accountId" | "visibility">>;

function NewJobDrawer({
  open,
  onOpenChange,
  drafts,
  accounts,
  onCreated,
  initial,
  initialError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: Draft[];
  accounts: HostedAccount[];
  onCreated: () => void;
  initial?: PublishSeed;
  initialError?: string | null;
}) {
  const toast = useToast();
  const { readOnly } = useRuntime();
  const session = useMemo(captureSession, []);
  const mounted = useRef(true), formEpoch = useRef(0), openRef = useRef(open);
  openRef.current = open;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const queryClient = useQueryClient();
  const [draftId, setDraftId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [visibility, setVisibility] =
    useState<PublishJobCreateRequest["visibility"]>("public");
  const [schedule, setSchedule] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    formEpoch.current++;
    setSubmitting(false);
    if (!open) return;
    setDraftId(initial?.draftId ? String(initial.draftId) : "");
    setAccountId(initial?.accountId ? String(initial.accountId) : "");
    setVisibility(initial?.visibility ?? "public");
    setSchedule("");
  }, [open, initial]);

  const draft = drafts.find((d) => String(d.id) === draftId);
  const account = accounts.find((a) => String(a.id) === accountId);
  const imagesReady = Boolean(draft?.images.length && draft.images.every(i => i.url));
  const draftGenerating = !!draft && (["queued", "writing"].includes(draft.generationState) || ["queued", "processing"].includes(draft.coverState));
  const ready = Boolean(!readOnly && draft?.title.trim() && account && account.status !== "expired" && imagesReady && !draftGenerating);
  // 发布前自查：不经过草稿页的人也能看到风险（命中只提醒，不拦截）
  const { words: customWords } = useBannedWords();
  const risks = useMemo(() => {
    if (!draft) return { banned: [], limits: [] };
    return {
      banned: summarizeBanned(checkBannedWords(`${draft.title}\n${draft.content}`, { extraWords: customWords })),
      limits: checkDraftLimits({ title: draft.title, content: draft.content, tags: draft.tags }),
    };
  }, [draft, customWords]);
  const highRisk = risks.limits.length > 0 || risks.banned.some((b) => b.severity === "high");

  const submit = async () => {
    if (!ready || submitting || !isCurrentSession(session)) return;
    const epoch = formEpoch.current;
    const active = () => mounted.current && openRef.current && formEpoch.current === epoch && isCurrentSession(session);
    setSubmitting(true);
    try {
      const scheduledAt = schedule ? new Date(schedule).getTime() : undefined;
      await api.createJob({
        draftId: Number(draftId),
        accountId: Number(accountId),
        personaVersion: account?.personaVersion,
        draftTextVersion: draft?.textVersion,
        draftImagesVersion: draft?.imagesVersion,
        visibility,
        scheduledAt:
          scheduledAt && Number.isFinite(scheduledAt) ? scheduledAt : undefined,
      });
      if (!isCurrentSession(session)) return;
      void queryClient.invalidateQueries({ queryKey: ["publish-jobs"] });
      if (!active()) return;
      toast.success("发布任务已创建", scheduledAt ? "将按定时执行" : "已进入待执行队列");
      onCreated();
      onOpenChange(false);
      setDraftId("");
      setAccountId("");
      setVisibility("public");
      setSchedule("");
    } catch (err) {
      if (!active()) return;
      toast.error("创建失败", err instanceof Error ? err.message : undefined);
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
    } finally {
      if (active()) setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onOpenChange={onOpenChange}
      side="right"
      ariaLabel="新建发布任务"
      className="w-full max-w-md"
    >
      <div className="flex h-full flex-col">
        <div className="border-b border-border px-6 py-4">
          <h2 className="text-base font-semibold text-foreground">新建发布</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
            {initial ? "将使用当前草稿和当前账号人设建立新的发布版本，请重新核对" : "选择草稿与账号，由插件在浏览器里执行发布"}
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          {initialError && <p role="alert" className="rounded-lg border border-border bg-muted p-3 text-xs leading-5 text-destructive">{initialError}</p>}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              草稿
            </p>
            <Select value={draftId} onValueChange={setDraftId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择草稿…" />
              </SelectTrigger>
              <SelectContent>
                {drafts.map((d) => (
                  <SelectItem key={d.id} value={String(d.id)}>
                    {d.title || `未命名草稿 #${d.id}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {draft && (risks.banned.length > 0 || risks.limits.length > 0) && (
            <div className="flex flex-col gap-1.5 rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs">
              <span className="font-medium text-amber-600">发布前自查</span>
              {risks.limits.map((l) => (
                <span key={l.field} className="font-medium text-rose-500">{l.message}（{l.used}/{l.max}）</span>
              ))}
              {risks.banned.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {risks.banned.map((b) => (
                    <span key={b.word} title={BANNED_KIND_META[b.kind].hint} className={`rounded-full bg-card px-2.5 py-1 ring-1 ${b.severity === "high" ? "text-rose-600 ring-rose-500/40" : "text-foreground/80 ring-amber-500/30"}`}>
                      {b.word}<span className="ml-1 text-muted-foreground">{BANNED_KIND_META[b.kind].label}</span>
                    </span>
                  ))}
                </div>
              )}
              <a href={`/drafts/${draft.id}`} className="text-primary underline-offset-2 hover:underline">去草稿里改</a>
            </div>
          )}

          {draft && (!imagesReady || draftGenerating) && <p role="alert" className="rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs text-amber-600">
            {draftGenerating ? "草稿或封面仍在生成，请完成后再发布。" : draft.images.length ? "图片尚未处理完成，请回草稿页等待或移除失败图片。" : "草稿需要至少一张图片，请先去草稿页上传或添加链接。"}
          </p>}

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              账号
            </p>
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="选择托管账号…" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem
                    key={a.id}
                    value={String(a.id)}
                    disabled={a.status === "expired"}
                  >
                    {`${a.nickname || a.xhsUserId || `账号 #${a.id}`}${a.status === "expired" ? "（登录失效）" : ""}`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {account?.redlines && <div className="space-y-1.5 rounded-xl border border-amber-500/20 bg-amber-500/5 p-3.5 text-xs leading-5">
            <p className="font-medium">「{account.nickname || "目标账号"}」内容红线</p>
            <p className="whitespace-pre-wrap">{account.redlines}</p>
            <p className="text-muted-foreground">请核对标题、正文和图片是否符合这些要求。</p>
          </div>}
          {account && draft && ((draft.accountId && draft.accountId !== account.id) || (draft.personaSnapshot?.accountId && draft.personaSnapshot.accountId !== account.id)) &&
            <p className="text-xs leading-5 text-amber-600">这篇草稿曾使用其他账号设置，发布前请核对当前语气和目标账号红线。</p>}
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              可见性
            </p>
            <RadioGroup
              value={visibility}
              onValueChange={(v) =>
                setVisibility(v as PublishJobCreateRequest["visibility"])
              }
              orientation="horizontal"
            >
              <RadioGroupItem value="public" label="公开" />
              <RadioGroupItem value="friends" label="仅好友" />
              <RadioGroupItem value="private" label="仅自己" />
            </RadioGroup>
          </div>

          <div>
            <p className="mb-1.5 text-xs font-medium text-muted-foreground">
              定时发布（可选）
            </p>
            <Input type="datetime-local" value={schedule} onChange={setSchedule} />
            <p className="mt-1 text-[11px] text-muted-foreground">
              留空则进入队列后立即执行
            </p>
          </div>
        </div>

        <div className="shrink-0 border-t border-border p-4">
          <ApprovalCard
            title="确认发布任务"
            description={
              ready
                ? `「${draft?.title || `草稿 #${draftId}`}」→ ${
                    account?.nickname || `账号 #${accountId}`
                  } · ${VISIBILITY_LABEL[visibility ?? "public"]}${
                    schedule ? ` · 定时 ${fmtDateTime(new Date(schedule).getTime())}` : " · 立即执行"
                  }`
                : "请先选择草稿和账号"
            }
            status={submitting ? "submitting" : "pending"}
            approveLabel={highRisk ? "仍要发布" : "确认发布"}
            onApprove={() => void submit()}
            onDismiss={() => onOpenChange(false)}
          />
        </div>
      </div>
    </Drawer>
  );
}

function RetryJobDrawer({ selection, accounts, drafts, submitting, onClose, onRetry, onCurrentDraft }: {
  selection: RetrySelection | null;
  accounts: HostedAccount[];
  drafts: Draft[];
  submitting: boolean;
  onClose: () => void;
  onRetry: () => void;
  onCurrentDraft: (job: PublishJob) => void;
}) {
  if (!selection) return null;
  const { job } = selection;
  const snapshot = job.draftSnapshot;
  const account = accounts.find(item => item.id === job.accountId);
  const draft = drafts.find(item => item.id === job.draftId);
  const persona = job.personaSnapshot;
  const { personaChanged, draftChanged } = comparePublishVersion(job, draft, account);
  const allowed = job.retryEligibility?.allowed === true;
  return <Drawer open onOpenChange={open => { if (!open && !submitting) onClose(); }} side="right" ariaLabel="重试原发布版本" className="w-full max-w-lg">
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4">
        <h2 className="text-base font-semibold text-foreground">重试原发布版本 #{job.id}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">确认后会立即重新排队，沿用下方原稿、图片、封面、账号人设与可见性。</p>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6 text-sm">
        {!allowed && <p role="alert" className="rounded-xl bg-amber-500/10 p-3 text-xs leading-5 text-amber-600">{job.retryEligibility?.reason ?? "该任务尚未确认可以安全重试，请刷新并核对原结果。"}</p>}
        {draftChanged && <p role="status" className="rounded-xl bg-amber-500/10 p-3 text-xs leading-5 text-amber-600">当前草稿已修改。本次重试仍使用原发布版本；要采用修改后的内容，请选择“用当前稿新建”。</p>}
        {personaChanged && <p role="status" className="rounded-xl bg-amber-500/10 p-3 text-xs leading-5 text-amber-600">账号人设已从 v{persona?.version} 更新到 v{account?.personaVersion}，请重新核对当前红线。本次重试保留原人设记录。</p>}
        <dl className="grid grid-cols-[5rem_1fr] gap-x-3 gap-y-2 text-xs leading-5">
          <dt className="text-muted-foreground">原账号</dt><dd>{job.accountSnapshot?.nickname || job.accountSnapshot?.xhsUserId || persona?.nickname || `账号 #${job.accountId}`}<span className="ml-1 text-muted-foreground">（{job.accountSnapshot?.xhsUserId || "历史身份未保存"}）</span></dd>
          <dt className="text-muted-foreground">可见性</dt><dd>{VISIBILITY_LABEL[job.visibility]}</dd>
          <dt className="text-muted-foreground">原排期</dt><dd>{fmtDateTime(job.scheduledAt)}；本次改为立即排队</dd>
          <dt className="text-muted-foreground">原封面</dt><dd>{job.coverSnapshot ? `${job.coverSnapshot.templateId} · ${job.coverSnapshot.headline}` : "未记录系统封面，沿用原图集"}</dd>
          <dt className="text-muted-foreground">原人设</dt><dd>v{persona?.version ?? "未知"}</dd>
        </dl>
        {snapshot && <section className="space-y-3 rounded-xl border border-border p-4">
          <h3 className="font-medium">{snapshot.title}</h3>
          <p className="whitespace-pre-wrap text-xs leading-6 text-muted-foreground">{snapshot.content}</p>
          {snapshot.tags.length > 0 && <p className="text-xs text-primary">{snapshot.tags.map(tag => `#${tag}`).join(" ")}</p>}
          <div className="grid grid-cols-3 gap-2">{snapshot.images.map((image, index) => <img key={`${index}:${image.url}`} src={mediaUrl(image.url)} alt={`原发布图片 ${index + 1}`} className="aspect-[3/4] w-full rounded-lg bg-muted object-cover" />)}</div>
        </section>}
        {persona && <section className="space-y-2 rounded-xl border border-border p-4 text-xs leading-5">
          <h3 className="font-medium">原人设与红线</h3>
          <p className="whitespace-pre-wrap">定位：{persona.positioning || "未设置"}</p>
          <p className="whitespace-pre-wrap">风格：{persona.styleNotes || "未设置"}</p>
          <p className="whitespace-pre-wrap">红线：{persona.redlines || "未设置"}</p>
          {personaChanged && <p className="whitespace-pre-wrap text-amber-600">当前红线：{account?.redlines || "未设置"}</p>}
        </section>}
        {draft && <Button variant="secondary" size="sm" disabled={submitting} onClick={() => onCurrentDraft(job)}>用当前稿新建</Button>}
        <p className="text-[11px] leading-5 text-muted-foreground">若已有笔记发布成功或结果未知，请先到小红书核对，避免重复发布。</p>
      </div>
      <div className="shrink-0 border-t border-border p-4">
        {allowed ? <ApprovalCard title="确认重试原版本" description={`「${snapshot?.title}」 · ${VISIBILITY_LABEL[job.visibility]} · 立即排队`} status={submitting ? "submitting" : "pending"} approveLabel="确认重试原版本" onApprove={onRetry} onDismiss={submitting ? undefined : onClose} />
          : <Button variant="ghost" onClick={onClose}>关闭</Button>}
      </div>
    </div>
  </Drawer>;
}

export default function PublishPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const { readOnly } = useRuntime(), workspaceAccount = useWorkspaceAccount(), { interval } = useObservation();
  const [createOpen, setCreateOpen] = useState(false);
  const [createSeed, setCreateSeed] = useState<PublishSeed>();
  const [seedError, setSeedError] = useState<string | null>(null);
  const consumedSeed = useRef("");
  const [retrySelection, setRetrySelection] = useState<RetrySelection | null>(null);

  const jobsQuery = useQuery({
    queryKey: ["publish-jobs"],
    queryFn: api.jobs,
    refetchInterval: q => interval(!!q.state.data?.some(job => ["pending", "running"].includes(job.status)), 5000, false, q.state.fetchFailureCount),
  });
  const draftsQuery = useQuery({ queryKey: ["drafts"], queryFn: api.drafts });
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
  });
  const requestedJob = searchParams.get("job");
  const detailJob = jobsQuery.data?.find(job => String(job.id) === requestedJob);
  const paramText = searchParams.toString();
  useEffect(() => {
    if (searchParams.get("new") !== "1") { consumedSeed.current = ""; return; }
    if (consumedSeed.current === paramText || !draftsQuery.isSuccess || !accountsQuery.isSuccess) return;
    consumedSeed.current = paramText;
    const draftParam = searchParams.get("draft"), accountParam = searchParams.get("account");
    const draft = draftsQuery.data.find(item => String(item.id) === draftParam);
    const candidate = accountParam ? accountsQuery.data.find(item => String(item.id) === accountParam)
      : draft?.accountId ? accountsQuery.data.find(item => item.id === draft.accountId)
      : workspaceAccount.canCreate ? workspaceAccount.account : null;
    setSeedError(draftParam && !draft ? "预填草稿无法读取，请选择当前账号下的有效草稿。" : accountParam && !candidate ? "预填账号无法读取，请重新选择有效目标账号。" : null);
    setCreateSeed({ draftId: draft?.id, accountId: candidate?.id }); setCreateOpen(true);
  }, [paramText, draftsQuery.data, draftsQuery.isSuccess, accountsQuery.data, accountsQuery.isSuccess, workspaceAccount.canCreate, workspaceAccount.account]);

  const invalidateJobs = () =>
    void queryClient.invalidateQueries({ queryKey: ["publish-jobs"] });

  const cancel = useMutation({
    mutationFn: (id: number) => api.cancelJob(id),
    onSuccess: () => {
      invalidateJobs();
      toast.success("任务已取消");
    },
    onError: (err) =>
      toast.error("取消失败", err instanceof Error ? err.message : undefined),
  });

  const retry = useMutation({
    mutationFn: submitOriginalRetry,
    onSuccess: () => {
      invalidateJobs();
      setRetrySelection(null);
      toast.success("原发布版本已重新排队");
    },
    onError: (err) => {
      invalidateJobs();
      toast.error("重试失败", err instanceof Error ? err.message : undefined);
    },
  });

  const runNow = useMutation({
    mutationFn: (job: PublishJob) => bridge.runPublishJob(job.id),
    onSuccess: () => toast.success("已通知插件立即执行"),
    onError: (err) =>
      toast.error(
        "无法通知插件",
        err instanceof Error ? err.message : "插件无响应",
      ),
  });

  const rows = useMemo<JobRow[]>(() => {
    const draftMap = new Map((draftsQuery.data ?? []).map((d) => [d.id, d]));
    const accountMap = new Map(
      (accountsQuery.data ?? []).map((a) => [a.id, a]),
    );
    return (jobsQuery.data ?? []).map((j) => ({
      ...j,
      ...publishVersionLabels(j, draftMap.get(j.draftId), accountMap.get(j.accountId)),
    }));
  }, [jobsQuery.data, draftsQuery.data, accountsQuery.data]);

  const columns = useMemo<TableColumn<JobRow>[]>(
    () => [
      {
        key: "draftTitle",
        header: "草稿",
        width: "2fr",
        sortable: true,
        cell: (row) => (
          <button type="button" onClick={() => { const next = new URLSearchParams(searchParams); next.set("job", String(row.id)); setSearchParams(next); }} className="block max-w-full truncate text-left font-medium text-foreground hover:text-primary">
            {row.draftTitle}{!row.draftSnapshot && <span className="ml-1 text-[10px] font-normal text-muted-foreground">（当前稿，历史原文未保存）</span>}
          </button>
        ),
      },
      {
        key: "accountName",
        header: "账号",
        width: "1.1fr",
        cell: (row) => (
          <span className="block truncate text-muted-foreground">
            {row.accountName}
          </span>
        ),
      },
      {
        key: "status",
        header: "状态",
        width: "110px",
        sortable: true,
        cell: (row) => (
          <AnimatedBadge
            size="sm"
            status={JOB_STATUS_META[row.status]?.status ?? "neutral"}
          >
            {JOB_STATUS_META[row.status]?.label ?? row.status}
          </AnimatedBadge>
        ),
      },
      {
        key: "outcome",
        header: "对账",
        width: "96px",
        cell: (row) => {
          if (row.status !== "done" || !row.outcome)
            return <span className="text-muted-foreground">—</span>;
          const meta: Record<string, { label: string; status: "success" | "warning" | "danger" | "neutral" }> = {
            verified: { label: "已核实", status: "success" },
            unverified: { label: "未核实", status: "warning" },
            login_required: { label: "需登录", status: "danger" },
            readback_error: { label: "读回失败", status: "neutral" },
          };
          const m = meta[row.outcome] ?? { label: row.outcome, status: "neutral" as const };
          return (
            <AnimatedBadge size="sm" status={m.status}>
              {m.label}
            </AnimatedBadge>
          );
        },
      },
      {
        key: "scheduledAt",
        header: "定时",
        width: "130px",
        sortable: true,
        sortValue: (row) => row.scheduledAt ?? 0,
        cell: (row) => (
          <span className="tabular-nums text-muted-foreground">
            {row.scheduledAt ? fmtDateTime(row.scheduledAt) : "立即"}
          </span>
        ),
      },
      {
        key: "error",
        header: "结果",
        width: "1.6fr",
        cell: (row) => {
          if ((row.status === "failed" || row.status === "running") && row.error)
            return (
              <span
                className="block truncate text-destructive"
                title={row.error}
              >
                {row.error}
              </span>
            );
          if (row.status === "done" && row.resultUrl)
            return (
              <a
                href={row.resultUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="size-3" />
                查看笔记
              </a>
            );
          return <span className="text-muted-foreground">—</span>;
        },
      },
      {
        key: "createdAt",
        header: "创建",
        width: "110px",
        sortable: true,
        cell: (row) => (
          <span className="tabular-nums text-muted-foreground">
            {timeAgo(row.createdAt)}
          </span>
        ),
      },
      {
        key: "actions",
        header: "",
        width: "150px",
        align: "right",
        cell: (row) => (
          <span className="inline-flex items-center gap-1">
            {row.status === "pending" ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readOnly || runNow.isPending}
                  onClick={() => runNow.mutate(row)}
                  title="通知插件立即执行"
                >
                  <Play className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={readOnly || cancel.isPending}
                  onClick={() => cancel.mutate(row.id)}
                  title="取消任务"
                >
                  <XCircle className="size-3.5" />
                </Button>
              </>
            ) : row.status === "failed" || row.status === "canceled" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={readOnly || retry.isPending}
                onClick={() => setRetrySelection(selectOriginalRetry(row))}
                title={row.retryEligibility?.allowed ? "核对后重试原发布版本" : row.retryEligibility?.reason ?? "核对原发布版本"}
              >
                <RotateCcw className="size-3.5" />
                核对重试
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [cancel, retry, runNow, readOnly, paramText],
  );

  const openCreate = () => {
    setSeedError(null); setCreateSeed({ accountId: workspaceAccount.canCreate ? workspaceAccount.accountId ?? undefined : undefined });
    setCreateOpen(true);
    const next = new URLSearchParams(searchParams);
    for (const key of ["draft", "account", "job", "visibility"]) next.delete(key);
    next.set("new", "1");
    setSearchParams(next, { replace: true });
  };

  const pending = jobsQuery.isPending;
  const errored = jobsQuery.isError;

  return (
    <div className="workspace-page flex min-h-full flex-col">
      <header className="mb-4"><h1 className="workspace-page-title">核对这一版，再交给浏览器</h1><p className="mt-2 text-sm text-muted-foreground">分别查看发布执行、站点核对和指标采样的结果。</p></header>
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <Button size="sm" disabled={readOnly} onClick={openCreate}>
          <Plus className="size-3.5" />
          新建发布
        </Button>
      </div>

      {pending ? (
        <PageLoading label="加载发布任务…" />
      ) : errored ? (
        <PageError error={jobsQuery.error} onRetry={jobsQuery.refetch} />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={SendHorizontal}
          title="还没有发布任务"
          description="选一篇草稿和目标账号，创建第一个发布任务"
          action={
            <Button size="sm" disabled={readOnly} onClick={openCreate}>
              <Plus className="size-3.5" />
              新建发布
            </Button>
          }
          className="py-20"
        />
      ) : (
        <Table
          data={rows}
          columns={columns}
          getRowId={(r) => String(r.id)}
          defaultSort={{ key: "createdAt", direction: "desc" }}
          rowHeight={56}
          height={520}
          emptyState={<EmptyState title="没有发布任务" />}
          className="rounded-2xl border border-border bg-card"
        />
      )}

      <NewJobDrawer
        open={createOpen}
        onOpenChange={(open) => {
          setCreateOpen(open);
          if (!open && searchParams.has("new")) {
            const next = new URLSearchParams(searchParams);
            for (const key of ["new", "draft", "account", "visibility"]) next.delete(key);
            setSearchParams(next, { replace: true });
          }
        }}
        drafts={draftsQuery.data ?? []}
        accounts={accountsQuery.data ?? []}
        onCreated={invalidateJobs}
        initial={createSeed}
        initialError={seedError}
      />
      <Drawer open={!!requestedJob} onOpenChange={open => { if (!open) { const next = new URLSearchParams(searchParams); next.delete("job"); setSearchParams(next); } }} side="right" ariaLabel="发布记录" className="w-full max-w-lg">
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
          <h2 className="text-base font-semibold">发布记录{detailJob ? ` #${detailJob.id}` : ""}</h2>
          {jobsQuery.isPending ? <PageLoading /> : jobsQuery.isError ? <PageError error={jobsQuery.error} onRetry={jobsQuery.refetch} /> : !detailJob ? <p role="alert" className="text-sm text-muted-foreground">此发布记录无法读取，可能已不存在或不属于当前登录用户。</p> : <>
            <ContentLinks items={[{ label: "原草稿", to: `/drafts/${detailJob.draftId}` }, { label: "目标账号", to: `/accounts?account=${detailJob.accountId}` }, ...(detailJob.status === "done" ? [{ label: "表现与复盘", to: `/insights/${detailJob.id}` }] : [])]} current="发布记录" />
            <p className="text-lg font-semibold">{detailJob.draftSnapshot?.title || `草稿 #${detailJob.draftId}`}</p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-3 text-sm"><dt className="text-muted-foreground">执行状态</dt><dd>{JOB_STATUS_META[detailJob.status].label}</dd><dt className="text-muted-foreground">站点核对</dt><dd>{detailJob.outcome === "verified" ? "已核实笔记" : detailJob.status === "running" ? "等待现场或站点核对，结果未知" : detailJob.outcome || "尚无核对结果"}</dd><dt className="text-muted-foreground">目标账号</dt><dd>{detailJob.personaSnapshot?.nickname || `账号 #${detailJob.accountId}`}</dd><dt className="text-muted-foreground">可见性</dt><dd>{VISIBILITY_LABEL[detailJob.visibility ?? "public"]}</dd><dt className="text-muted-foreground">笔记 ID</dt><dd className="break-all">{detailJob.noteId || "尚未核对到"}</dd><dt className="text-muted-foreground">创建时间</dt><dd>{fmtDateTime(detailJob.createdAt)}</dd></dl>
            {detailJob.error && <p className="whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs leading-6">{detailJob.error}</p>}
            <div className="whitespace-pre-wrap rounded-lg border border-border p-4 text-sm leading-7">{detailJob.draftSnapshot?.content || "此历史记录未保存原正文"}</div>
            {detailJob.draftSnapshot?.images.length ? <div className="grid grid-cols-3 gap-2">{detailJob.draftSnapshot.images.map((image, index) => <img key={index} src={mediaUrl(image.url)} alt={`发布图 ${index + 1}`} className="aspect-[3/4] w-full rounded-md object-cover" />)}</div> : null}
          </>}
        </div>
      </Drawer>
      <RetryJobDrawer selection={retrySelection} accounts={accountsQuery.data ?? []} drafts={draftsQuery.data ?? []} submitting={retry.isPending}
        onClose={() => setRetrySelection(null)} onRetry={() => { if (retrySelection && !retry.isPending) retry.mutate(retrySelection); }}
        onCurrentDraft={job => { setRetrySelection(null); setCreateSeed({ draftId: job.draftId, accountId: job.accountId, visibility: job.visibility }); setCreateOpen(true); }} />
    </div>
  );
}
