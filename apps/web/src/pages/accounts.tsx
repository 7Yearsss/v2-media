import { Link2, PenLine, RefreshCcw, Unplug, Users, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ACCOUNT_PERSONA_LIMITS, type HostedAccount } from "@v2media/shared";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import { TiltCard } from "@/components/motion/tilt-card";
import { Drawer } from "@/components/motion/drawer";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import { useExtensionStatus } from "@/components/app/app-shell";
import { api, ApiError, getToken, mediaUrl } from "@/lib/api";
import { bridge } from "@/lib/bridge";
import { ACCOUNT_STATUS_META, timeAgo } from "@/lib/format";
import { useToast } from "@/lib/toast";

function AccountCard({
  account,
  onUnbind,
  unbinding,
  onEditPersona,
}: {
  account: HostedAccount;
  onUnbind: () => void;
  unbinding: boolean;
  onEditPersona: () => void;
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

        <div className="space-y-1 text-xs leading-5 text-muted-foreground">
          <p className="line-clamp-2">{account.positioning || "尚未设置人设，AI 按通用风格写作"}</p>
          {account.styleNotes && <p className="line-clamp-1">风格：{account.styleNotes}</p>}
          {account.redlines && <p className="line-clamp-1">红线：{account.redlines}</p>}
        </div>
        <div className="mt-auto flex justify-between border-t border-border pt-3">
          <Button size="sm" variant="outline" onClick={onEditPersona}><PenLine className="size-3.5" />编辑人设</Button>
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

function PersonaDrawer({ account, onClose }: { account: HostedAccount | null; onClose: () => void }) {
  const client = useQueryClient();
  const toast = useToast();
  const [positioning, setPositioning] = useState("");
  const [styleNotes, setStyleNotes] = useState("");
  const [redlines, setRedlines] = useState("");
  const [version, setVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const activeId = useRef(account?.id);
  activeId.current = account?.id;
  const load = (a: HostedAccount) => {
    setPositioning(a.positioning); setStyleNotes(a.styleNotes); setRedlines(a.redlines); setVersion(a.personaVersion); setError("");
  };
  useEffect(() => { if (account) load(account); }, [account?.id]);
  const save = async () => {
    if (!account || saving) return;
    setSaving(true); setError("");
    try {
      const updated = await api.updateAccountPersona(account.id, { version, positioning, styleNotes, redlines });
      client.setQueryData<HostedAccount[]>(["accounts"], rows => rows?.map(a => a.id === updated.id ? updated : a));
      toast.success("账号人设已保存");
      if (activeId.current === updated.id) onClose();
    } catch (e) {
      if (activeId.current === account.id) setError(e instanceof Error ? e.message : "保存失败");
      if (e instanceof ApiError && e.status === 409) void client.invalidateQueries({ queryKey: ["accounts"] });
    } finally { setSaving(false); }
  };
  const reload = async () => {
    if (!account) return;
    try { const rows = await api.accounts(); client.setQueryData(["accounts"], rows); const current = rows.find(a => a.id === account.id); if (current && activeId.current === current.id) load(current); }
    catch (e) { if (activeId.current === account.id) setError(e instanceof Error ? e.message : "读取失败"); }
  };
  return <Drawer open={!!account} onOpenChange={open => { if (!open) onClose(); }} side="right" ariaLabel="编辑账号人设" className="w-full max-w-lg">
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 py-4"><h2 className="text-base font-semibold">{account?.nickname || "账号人设"}</h2>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">选题、成稿、分析和改写会使用这些设置。留空则沿用通用写法。</p>
      </div>
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-6">
        {[
          { label: "账号定位", value: positioning, set: setPositioning, max: ACCOUNT_PERSONA_LIMITS.positioning, placeholder: "写给谁、主要写什么，例如：下班备餐、家庭厨房整理" },
          { label: "表达风格", value: styleNotes, set: setStyleNotes, max: ACCOUNT_PERSONA_LIMITS.styleNotes, placeholder: "例如：像朋友分享，短句、有步骤，少用夸张词" },
          { label: "内容红线", value: redlines, set: setRedlines, max: ACCOUNT_PERSONA_LIMITS.redlines, placeholder: "明确不写什么，例如：不编造亲身体验、不做效果承诺" },
        ].map(field => <label key={field.label} className="block space-y-2 text-sm">
          <span className="font-medium">{field.label}</span>
          <textarea aria-label={field.label} rows={4} value={field.value} onChange={e => field.set(e.target.value)} maxLength={field.max} placeholder={field.placeholder}
            className="w-full resize-y rounded-xl border border-border bg-background px-3 py-2 text-sm leading-6 outline-none focus:border-primary" />
          <span className="block text-right text-[11px] text-muted-foreground">{field.value.length}/{field.max}</span>
        </label>)}
        <p className="text-xs leading-5 text-muted-foreground">红线会进入 AI 提示并在发布前展示，请结合实际内容自查。现有违禁词检查继续生效。</p>
        {error && <div role="alert" className="space-y-2 text-xs text-destructive"><p>{error}</p><button type="button" onClick={() => void reload()} className="underline">重新读取账号人设</button></div>}
      </div>
      <div className="flex justify-end gap-2 border-t border-border p-4"><Button variant="ghost" size="sm" onClick={onClose} disabled={saving}>取消</Button>
        <Button size="sm" onClick={() => void save()} disabled={saving}>{saving ? "保存中…" : "保存人设"}</Button>
      </div>
    </div>
  </Drawer>;
}

export default function AccountsPage() {
  const toast = useToast();
  const queryClient = useQueryClient();
  const { online } = useExtensionStatus();
  const [editingId, setEditingId] = useState<number | null>(null);

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
      // 插件校验 apiBase === 页面 origin（只信任工作台同源），经 vite/同源代理访问 API
      await bridge.setAuth({ apiBase: window.location.origin, token });
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
    <div className="w-full px-6 pb-8 pt-6">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
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
              onEditPersona={() => setEditingId(account.id)}
            />
          ))}
        </div>
      )}
      <PersonaDrawer account={accountsQuery.data?.find(a => a.id === editingId) ?? null} onClose={() => setEditingId(null)} />
    </div>
  );
}
