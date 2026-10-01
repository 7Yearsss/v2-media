import { useState } from "react";
import type { Collection } from "@v2media/shared";
import { CollectionPicker } from "@/components/app/collection-picker";
import { cn } from "@/lib/utils";

const MAX_TABS = 5;

type PickerProps = Omit<Parameters<typeof CollectionPicker>[0], "collections" | "value" | "compact" | "onPick">;

/**
 * 采集库标签栏：全部 / 未分组 / 常用库（置顶 → 最近使用 → 笔记多的）直接点选，
 * 其余的从「全部库」里搜索，也是新建 / 改名 / 删除的入口。当前库一定显示在标签里。
 */
export function CollectionTabs({
  collections,
  value,
  onChange,
  onPick,
  onDropNotes,
  ...picker
}: PickerProps & {
  /** 把笔记（卡片 / 行拖过来）放到某个库；null = 移出库（未分组）。 */
  onDropNotes?: (noteIds: number[], collectionId: number | null) => void;
  collections: Collection[];
  /** "" | "none" | 库 id 字符串 */
  value: string;
  onChange: (value: string) => void;
  onPick: (id: number) => void;
}) {
  const byId = new Map(collections.map((c) => [c.id, c]));
  const ordered: Collection[] = [];
  const seen = new Set<number>();
  const push = (c?: Collection) => {
    if (c && !seen.has(c.id)) {
      seen.add(c.id);
      ordered.push(c);
    }
  };
  push(byId.get(Number(value)));
  picker.pinned.forEach((id) => push(byId.get(id)));
  picker.recent.forEach((id) => push(byId.get(id)));
  [...collections].sort((a, b) => b.noteCount - a.noteCount).forEach(push);
  const shown = ordered.slice(0, MAX_TABS);

  const [dropOver, setDropOver] = useState<string | null>(null);
  const tab = (active: boolean, key?: string) =>
    cn(
      "inline-flex h-9 max-w-44 shrink-0 items-center gap-1.5 rounded-xl px-3.5 text-sm outline-none transition-[background-color,box-shadow,transform] focus-visible:ring-2 focus-visible:ring-ring",
      active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground hover:bg-muted/70",
      key && dropOver === key && "scale-105 bg-primary/15 text-foreground ring-2 ring-primary",
    );
  // 拖拽落点：只接受内容库卡片 / 行拖过来的笔记
  const drop = (key: string, collectionId: number | null) =>
    onDropNotes
      ? {
          onDragOver: (e: React.DragEvent) => {
            if (!e.dataTransfer.types.includes("application/x-v2m-notes")) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropOver(key);
          },
          onDragLeave: () => setDropOver((k) => (k === key ? null : k)),
          onDrop: (e: React.DragEvent) => {
            setDropOver(null);
            try {
              const ids = JSON.parse(e.dataTransfer.getData("application/x-v2m-notes")) as number[];
              if (Array.isArray(ids) && ids.length) {
                e.preventDefault();
                onDropNotes(ids, collectionId);
              }
            } catch { /* 不是我们的拖拽数据 */ }
          },
        }
      : {};

  return (
    <div role="tablist" aria-label="采集库" className="flex min-w-0 flex-wrap items-center gap-2">
      <button type="button" role="tab" aria-selected={value === ""} onClick={() => onChange("")} className={tab(value === "")}>全部</button>
      <button type="button" role="tab" aria-selected={value === "none"} onClick={() => onChange("none")} className={tab(value === "none", "none")} {...drop("none", null)}>未分组</button>
      {shown.map((c) => {
        const active = String(c.id) === value;
        return (
          <button key={c.id} type="button" role="tab" aria-selected={active} onClick={() => onPick(c.id)} title={c.name} className={tab(active, String(c.id))} {...drop(String(c.id), c.id)}>
            <span className="truncate">{c.name}</span>
            <span className={cn("shrink-0 text-xs tabular-nums", active ? "text-primary-foreground/80" : "opacity-60")}>{c.noteCount}</span>
          </button>
        );
      })}
      <CollectionPicker {...picker} collections={collections} value={value} onPick={onPick} compact />
    </div>
  );
}
