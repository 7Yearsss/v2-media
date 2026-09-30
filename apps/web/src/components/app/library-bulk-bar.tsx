import { Download, FolderInput, SendToBack, Trash2, X } from "lucide-react";
import type { Collection } from "@v2media/shared";
import { Button } from "@/components/motion/button";

export function LibraryBulkBar({
  count,
  totalShown,
  collections,
  busy,
  onSelectAll,
  onClear,
  onMove,
  onDraft,
  onExport,
  onDelete,
}: {
  count: number;
  totalShown: number;
  collections: Collection[];
  busy: boolean;
  onSelectAll: () => void;
  onClear: () => void;
  /** null = 移出库（回到未分组） */
  onMove: (collectionId: number | null) => void;
  onDraft: () => void;
  onExport: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      role="toolbar"
      aria-label="批量操作"
      className="pointer-events-auto flex flex-wrap items-center gap-2 rounded-2xl border border-border bg-card/95 px-3 py-2 shadow-xl backdrop-blur"
    >
      <span className="px-1 text-sm font-medium tabular-nums">已选 {count} 条</span>
      {count < totalShown ? (
        <button type="button" onClick={onSelectAll} className="text-xs text-primary hover:underline">
          全选已加载的 {totalShown} 条
        </button>
      ) : null}
      <span className="mx-1 hidden h-5 w-px bg-border sm:block" />
      <label className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        <FolderInput className="size-3.5" />
        <select
          aria-label="移入采集库"
          disabled={busy}
          value=""
          onChange={(e) => {
            if (e.target.value === "") return;
            onMove(e.target.value === "none" ? null : Number(e.target.value));
          }}
          className="h-8 rounded-lg border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          <option value="">移入库…</option>
          <option value="none">移出（未分组）</option>
          {collections.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <Button size="sm" variant="secondary" disabled={busy} onClick={onDraft}>
        <SendToBack className="size-3.5" />
        送入草稿
      </Button>
      <Button size="sm" variant="outline" disabled={busy} onClick={onExport}>
        <Download className="size-3.5" />
        导出所选
      </Button>
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={onDelete}
        className="text-destructive hover:text-destructive"
      >
        <Trash2 className="size-3.5" />
        删除
      </Button>
      <button
        type="button"
        aria-label="取消选择"
        title="取消选择（Esc）"
        onClick={onClear}
        className="grid size-8 place-items-center rounded-lg text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <X className="size-4" />
      </button>
    </div>
  );
}
