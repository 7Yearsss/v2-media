import { Link2, RefreshCcw, Unplug, Users, Zap } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HostedAccount } from "@v2media/shared";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { TiltCard } from "@/components/motion/tilt-card";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { useExtensionStatus } from "@/components/app/app-shell";
import { API_BASE, api, getToken, mediaUrl } from "@/lib/api";
import { bridge } from "@/lib/bridge";
import { ACCOUNT_STATUS_META, timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";

function AccountCard({
  account,
  onUnbind,
  unbinding,
}: {
  account: HostedAccount;
  onUnbind: () => void;
  unbinding: boolean;
}) {
  const meta = ACCOUNT_STATUS_META[account.status] ?? ACCOUNT_STATUS_META.unknown!;
  return (
    <TiltCard max={8} className="h-full">
      <div className="flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-5">
        <div className="flex items-start gap-3">
          {account.avatar ? (
            <img
              src={mediaUrl(account.avatar)}
              alt={account.nickname}
              className="size-11 rounded-full object-cover"
            />
          ) : (
            <span className="grid size-11 shrink-0 place-items-center rounded-full bg-primary/15 text-sm font-semibold text-primary">
              {(account.nickname || "?").slice(0, 1)}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-foreground">
              {account.nickname || "未命名账号"}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {account.xhsUserId || "—"}
            </p>
          </div>
          <AnimatedBadge
            size="sm"
            status={meta.status}
            pulse={account.status === "online"}
          >
            {meta.label}
          </AnimatedBadge>
        </div>

        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="rounded-full border border-border px-2 py-0.5">
            {account.subType === "creator" ? "创作者平台" : "PC 端"}
          </span>
          <span className="truncate">心跳 {timeAgo(account.lastSeenAt)}</span>
        </div>

        {account.statusMessage ? (
          <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
            {account.statusMessage}
          </p>
        ) : null}

        <div className="mt-auto flex justify-end border-t border-border pt-3">
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground hover:text-destructive"
            disabled={unbinding}
            onClick={onUnbind}
          >
            <Unplug className="size-3.5" />
            解绑
          </Button>
        </div>
      </div>
    </TiltCard>
  );
}

export default function AccountsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { online } = useExtensionStatus();

  const accountsQuery = useQuery({
    queryKey: ["accounts"],
    queryFn: api.accounts,
    refetchInterval: 30_000,
  });

  const unbind = useMutation({
    mutationFn: (id: number) => api.deleteAccount(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["accounts"] });
      toast.success("已解绑账号");
    },
    onError: (err) =>
      toast.error("解绑失败", err instanceof Error ? err.message : undefined),
  });

  const authorize = async () => {
    const token = getToken();
    if (!token) {
      toast.error("请先登录");
      return;
    }
    try {
      await bridge.setAuth({ apiBase: API_BASE, token });
      toast.success("插件已授权", "扩展已拿到 API 地址与登录令牌");
    } catch (err) {
      toast.error(
        "未检测到插件",
        err instanceof Error ? err.message : "请确认扩展已安装并刷新页面",
      );
    }
  };

  const sync = async () => {
    try {
      await bridge.syncAccounts();
      toast.success("已请求插件同步账号", "稍候自动刷新");
      window.setTimeout(
        () => void queryClient.invalidateQueries({ queryKey: ["accounts"] }),
        1500,
      );
    } catch (err) {
      toast.error(
        "同步失败",
        err instanceof Error ? err.message : "插件无响应",
      );
    }
  };

  return (
    <div className="mx-auto w-full max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold tracking-tight text-foreground">
            账号矩阵
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            插件心跳上报的托管账号，发布任务按账号分发
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void sync()}
            disabled={online !== true}
            title={online ? undefined : "需先检测到插件"}
          >
            <RefreshCcw className="size-3.5" />
            同步账号
          </Button>
          <Button size="sm" onClick={() => void authorize()}>
            <Zap className="size-3.5" />
            授权插件
          </Button>
        </div>
      </div>

      {online === false ? (
        <div className="mb-6 flex items-start gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-5 text-amber-700 dark:text-amber-400">
          <Link2 className="mt-0.5 size-4 shrink-0" />
          <p>
            未检测到浏览器插件。安装扩展后回到本页点「授权插件」，插件才会开始
            心跳上报已登录的小红书账号。
          </p>
        </div>
      ) : null}

      {accountsQuery.isPending ? (
        <PageLoading label="加载托管账号…" />
      ) : accountsQuery.isError ? (
        <PageError error={accountsQuery.error} onRetry={accountsQuery.refetch} />
      ) : accountsQuery.data!.length === 0 ? (
        <EmptyState
          icon={Users}
          title="还没有托管账号"
          description="插件在小红书页面检测到登录态后，会通过心跳自动上报到这里"
          action={
            <Button size="sm" onClick={() => void authorize()}>
              <Zap className="size-3.5" />
              授权插件
            </Button>
          }
          className="py-16"
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {accountsQuery.data!.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              unbinding={unbind.isPending}
              onUnbind={() => unbind.mutate(account.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
