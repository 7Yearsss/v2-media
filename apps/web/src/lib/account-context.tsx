import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import type { HostedAccount } from "@v2media/shared";
import { api, captureSession, isCurrentSession } from "./api";
import { captureUserStorage } from "./user-storage";
import { cn } from "./utils";
import { useObservation } from "./hooks/use-observation";

type AccountSelection = number | null | "invalid";
type AccountStatus = "ready" | "loading" | "error" | "unavailable";

export function parseWorkspaceAccountSelection(raw: string | null): AccountSelection {
  if (raw === null || raw === "null") return null;
  if (!/^[1-9]\d*$/.test(raw)) return "invalid";
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : "invalid";
}

/** Failed refreshes must not turn a previously selected identity into a verified one. */
export function resolveWorkspaceAccountSelection(
  selection: AccountSelection,
  accounts: HostedAccount[] | undefined,
  queryStatus: "pending" | "error" | "success",
): { status: AccountStatus; account: HostedAccount | null } {
  if (queryStatus === "error") return { status: "error", account: null };
  if (queryStatus !== "success") return { status: "loading", account: null };
  if (selection === null) return { status: "ready", account: null };
  const account = accounts?.find(item => item.id === selection && !item.archivedAt) ?? null;
  return { status: account ? "ready" : "unavailable", account };
}

interface WorkspaceAccountContextValue {
  /** Only use as a new-action default when canCreate is true. */
  accountId: number | null;
  selectedAccountId: AccountSelection;
  account: HostedAccount | null;
  accounts: HostedAccount[];
  status: AccountStatus;
  canCreate: boolean;
  setAccountId: (id: number | null) => void;
  refetch: () => void;
}

const WorkspaceAccountContext = createContext<WorkspaceAccountContextValue | null>(null);

export function WorkspaceAccountProvider({ children }: { children: ReactNode }) {
  const session = useMemo(captureSession, []);
  const [storage] = useState(() => captureUserStorage("v2m.workspace.account"));
  const [selection, setSelection] = useState(() => parseWorkspaceAccountSelection(storage.getItem()));
  const observation = useObservation();
  const query = useQuery({ queryKey: ["accounts"], queryFn: api.accounts,
    refetchInterval: query => observation.interval(false, 2000, 30_000, query.state.fetchFailureCount) });
  const accounts = useMemo(() => (query.data ?? []).filter(item => !item.archivedAt), [query.data]);
  const resolved = resolveWorkspaceAccountSelection(selection, accounts, query.status);
  const status = isCurrentSession(session) ? resolved.status : "loading";

  useEffect(() => {
    const receive = (event: StorageEvent) => {
      if ((event.key === storage.key || event.key === null) && isCurrentSession(session)) {
        setSelection(parseWorkspaceAccountSelection(storage.getItem()));
      }
    };
    window.addEventListener("storage", receive);
    return () => window.removeEventListener("storage", receive);
  }, [session, storage]);

  const value: WorkspaceAccountContextValue = {
    selectedAccountId: selection,
    accountId: status === "ready" ? resolved.account?.id ?? null : null,
    account: status === "ready" ? resolved.account : null,
    accounts,
    status,
    canCreate: status === "ready",
    setAccountId(id) {
      if (!isCurrentSession(session)) return;
      if (id !== null && (query.status !== "success" || !accounts.some(item => item.id === id))) return;
      storage.setItem(id === null ? "null" : String(id));
      setSelection(id);
    },
    refetch: () => { void query.refetch(); },
  };
  return <WorkspaceAccountContext.Provider value={value}>{children}</WorkspaceAccountContext.Provider>;
}

export function useWorkspaceAccount() {
  const context = useContext(WorkspaceAccountContext);
  if (!context) throw new Error("useWorkspaceAccount requires WorkspaceAccountProvider");
  return context;
}

export function WorkspaceAccountSelector({ className, label = "写作账号", showDetails = true }: {
  className?: string;
  label?: string;
  showDetails?: boolean;
}) {
  const workspace = useWorkspaceAccount();
  const unavailable = workspace.status === "unavailable";
  const unconfirmed = workspace.status === "loading" || workspace.status === "error";
  const suffix = workspace.status === "error" ? " · 状态未知" : workspace.status === "loading" ? " · 待确认" : "";
  const value = workspace.selectedAccountId === null ? "generic" : String(workspace.selectedAccountId);
  return <div className={cn("min-w-0", className)}>
    <label className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
      <span className="shrink-0">{label}</span>
      <select aria-label={label} value={value} disabled={workspace.status === "loading"}
        onChange={event => workspace.setAccountId(event.target.value === "generic" ? null : Number(event.target.value))}
        className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-card px-2 text-sm text-foreground">
        <option value="generic">通用风格{suffix}</option>
        {workspace.selectedAccountId !== null && !workspace.accounts.some(item => String(item.id) === value) &&
          <option value={value} disabled>{unavailable ? "原写作账号不可用" : "原写作账号待确认"}</option>}
        {workspace.accounts.map(account => <option key={account.id} value={account.id} disabled={unconfirmed}>{account.nickname || `账号 #${account.id}`}{suffix}</option>)}
      </select>
    </label>
    {showDetails && <p aria-live="polite" className="mt-1 text-[11px] leading-4 text-muted-foreground">
      {workspace.status === "loading" ? "正在确认账号…" : workspace.status === "error"
        ? <>账号状态未知，<button type="button" className="text-primary" onClick={workspace.refetch}>重新读取</button></>
        : unavailable ? "原账号已归档或不可访问，请明确重新选择。"
          : "用于新内容；已有关联内容保留原账号。"}
    </p>}
  </div>;
}
