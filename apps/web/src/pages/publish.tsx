import {
  ExternalLink,
  Play,
  Plus,
  RotateCcw,
  SendHorizontal,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
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
import { api } from "@/lib/api";
import { bridge } from "@/lib/bridge";
import {
  fmtDateTime,
  JOB_STATUS_META,
  timeAgo,
  VISIBILITY_LABEL,
} from "@/lib/format";
import { useToast } from "@/lib/toast";

type JobRow = PublishJob & { draftTitle: string; accountName: string };

function NewJobDrawer({
  open,
  onOpenChange,
  drafts,
  accounts,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  drafts: Draft[];
  accounts: HostedAccount[];
  onCreated: () => void;
}) {
  const toast = useToast();
  const [draftId, setDraftId] = useState("");
  const [accountId, setAccountId] = useState("");
  const [visibility, setVisibility] =
    useState<PublishJobCreateRequest["visibility"]>("public");
  const [schedule, setSchedule] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const draft = drafts.find((d) => String(d.id) === draftId);
  const account = accounts.find((a) => String(a.id) === accountId);
  const imagesReady = Boolean(draft?.images.length && draft.images.every(i => i.url));
  const ready = Boolean(draftId && accountId && imagesReady);
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
    if (!ready || submitting) return;
    setSubmitting(true);
    try {
      const scheduledAt = schedule ? new Date(schedule).getTime() : undefined;
      await api.createJob({
        draftId: Number(draftId),
        accountId: Number(accountId),
        visibility,
        scheduledAt:
          scheduledAt && Number.isFinite(scheduledAt) ? scheduledAt : undefined,
      });
      toast.success("发布任务已创建", scheduledAt ? "将按定时执行" : "已进入待执行队列");
      onCreated();
      onOpenChange(false);
      setDraftId("");
      setAccountId("");
      setVisibility("public");
      setSchedule("");
    } catch (err) {
      toast.error("创建失败", err instanceof Error ? err.message : undefined);
    } finally {
      setSubmitting(false);
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
            选择草稿与账号，由插件在浏览器里执行发布
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
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

          {draft && !imagesReady && <p role="alert" className="rounded-xl bg-amber-500/10 px-3.5 py-3 text-xs text-amber-600">
            {draft.images.length ? "图片尚未处理完成，请回草稿页等待或移除失败图片。" : "草稿需要至少一张图片，请先去草稿页上传或添加链接。"}
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
                    {a.nickname || a.xhsUserId || `账号 #${a.id}`}
                    {a.status === "expired" ? "（登录失效）" : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

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

export default function PublishPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [createOpen, setCreateOpen] = useState(searchParams.get("new") === "1");

  const jobsQuery = useQuery({
    queryKey: ["publish-jobs"],
    queryFn: api.jobs,
    refetchInterval: 15_000,
  });
  const draftsQuery = useQuery({ queryKey: ["drafts"], queryFn: api.drafts });
  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
  });

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

  // TODO(契约缺口)：契约没有独立的 retry 端点——重试按同参数重新 POST /api/publish/jobs
  const retry = useMutation({
    mutationFn: (job: PublishJob) =>
      api.createJob({
        draftId: job.draftId,
        accountId: job.accountId,
        visibility: job.visibility,
      }),
    onSuccess: () => {
      invalidateJobs();
      toast.success("已重新排队发布");
    },
    onError: (err) =>
      toast.error("重试失败", err instanceof Error ? err.message : undefined),
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
      draftTitle:
        draftMap.get(j.draftId)?.title || `草稿 #${j.draftId}`,
      accountName:
        accountMap.get(j.accountId)?.nickname ||
        accountMap.get(j.accountId)?.xhsUserId ||
        `账号 #${j.accountId}`,
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
          <span className="block truncate font-medium text-foreground">
            {row.draftTitle}
          </span>
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
          if (row.status === "failed" && row.error)
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
                  disabled={runNow.isPending}
                  onClick={() => runNow.mutate(row)}
                  title="通知插件立即执行"
                >
                  <Play className="size-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={cancel.isPending}
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
                disabled={retry.isPending}
                onClick={() => retry.mutate(row)}
                title="按同参数重新发布"
              >
                <RotateCcw className="size-3.5" />
                重试
              </Button>
            ) : null}
          </span>
        ),
      },
    ],
    [cancel, retry, runNow],
  );

  const openCreate = () => {
    setCreateOpen(true);
    if (!searchParams.has("new")) {
      searchParams.set("new", "1");
      setSearchParams(searchParams, { replace: true });
    }
  };

  const pending = jobsQuery.isPending;
  const errored = jobsQuery.isError;

  return (
    <div className="flex h-full w-full flex-col px-6 pb-8 pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <Button size="sm" onClick={openCreate}>
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
            <Button size="sm" onClick={openCreate}>
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
            searchParams.delete("new");
            setSearchParams(searchParams, { replace: true });
          }
        }}
        drafts={draftsQuery.data ?? []}
        accounts={accountsQuery.data ?? []}
        onCreated={invalidateJobs}
      />
    </div>
  );
}
