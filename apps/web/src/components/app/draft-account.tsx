import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api } from "@/lib/api";
import { useToast } from "@/lib/toast";

export function DraftAccount({ draftId, beforeChange }: { draftId: number; beforeChange: () => Promise<boolean> }) {
  const client = useQueryClient();
  const toast = useToast();
  const accounts = useQuery({ queryKey: ["accounts"], queryFn: api.accounts });
  const draft = useQuery({ queryKey: ["draft-media", draftId], queryFn: () => api.draft(draftId) }).data;
  const [saving, setSaving] = useState(false);
  const account = accounts.data?.find(a => a.id === draft?.accountId);
  const change = async (value: string) => {
    setSaving(true);
    try {
      if (!(await beforeChange())) { toast.error("请先重试保存文字"); return; }
      const updated = await api.updateDraft(draftId, { accountId: value ? Number(value) : null });
      client.setQueryData(["draft-media", draftId], updated);
      void client.invalidateQueries({ queryKey: ["drafts"] });
    } catch (e) { toast.error("写作账号更新失败", e instanceof Error ? e.message : undefined); }
    finally { setSaving(false); }
  };
  const snapshot = draft?.personaSnapshot;
  const changedSinceGeneration = snapshot?.accountId === account?.id && snapshot?.version !== account?.personaVersion;
  const switchedSinceGeneration = snapshot && snapshot.accountId !== draft?.accountId;
  return <div className="space-y-1.5 rounded-xl border border-border p-3">
    <label className="flex flex-wrap items-center gap-2 text-xs font-medium">写作账号
      <select aria-label="写作账号" value={draft?.accountId ?? ""} disabled={saving || !draft || accounts.isPending} onChange={e => void change(e.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm">
        <option value="">通用风格</option>{accounts.data?.map(a => <option key={a.id} value={a.id}>{a.nickname || a.xhsUserId}</option>)}
      </select>
    </label>
    {accounts.isError && <p role="alert" className="text-xs text-destructive">账号读取失败 <button onClick={() => void accounts.refetch()} className="underline">重试</button></p>}
    {account?.positioning && <p className="line-clamp-2 text-xs text-muted-foreground">定位：{account.positioning}</p>}
    {account?.styleNotes && <p className="line-clamp-2 text-xs text-muted-foreground">风格：{account.styleNotes}</p>}
    {account?.redlines && <p className="text-xs leading-5 text-muted-foreground">红线：{account.redlines}</p>}
    {changedSinceGeneration && <p className="text-xs text-amber-600">人设已更新，新的 AI 改写会使用当前设置。</p>}
    {switchedSinceGeneration && <p className="text-xs text-amber-600">这篇稿曾按「{snapshot.nickname || "通用风格"}」成稿，AI 改写会使用当前账号设置。</p>}
  </div>;
}
