import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, FolderOpen, Pencil, Pin, PinOff, Plus, Search, Trash2 } from "lucide-react";
import type { Collection } from "@v2media/shared";
import { cn } from "@/lib/utils";

const RECENT_SHOWN = 4;

/**
 * 采集库选择器：一个按钮 + 带搜索的面板（置顶 / 最近使用 / 全部），
 * 行内可置顶、改名、删除，底部可新建。库再多这一行也不变长。
 */
export function CollectionPicker({
  collections,
  value,
  pinned,
  recent,
  creating,
  onPick,
  onTogglePin,
  onRename,
  onDelete,
  onCreate,
  compact,
}: {
  collections: Collection[];
  /** "" | "none" | 库 id 字符串；仅当是库 id 时按钮显示该库 */
  value: string;
  pinned: number[];
  recent: number[];
  creating?: boolean;
  onPick: (id: number) => void;
  onTogglePin: (id: number) => void;
  onRename: (c: Collection) => void;
  onDelete: (c: Collection) => void;
  onCreate: (name: string) => void;
  /** 紧凑按钮「全部库 N」：标签栏放不下的库从这里选，不高亮当前库。 */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);

  const current = compact ? undefined : collections.find((c) => String(c.id) === value);

  const close = () => {
    setOpen(false);
    setAdding(false);
    setNewName("");
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sections = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (needle) {
      return [{ title: "", rows: collections.filter((c) => c.name.toLowerCase().includes(needle)) }].filter(
        (s) => s.rows.length > 0,
      );
    }
    const byId = new Map(collections.map((c) => [c.id, c]));
    const pin = pinned.map((id) => byId.get(id)).filter((c): c is Collection => Boolean(c));
    const seen = new Set(pin.map((c) => c.id));
    const rec: Collection[] = [];
    for (const id of recent) {
      const c = byId.get(id);
      if (c && !seen.has(id) && rec.length < RECENT_SHOWN) {
        rec.push(c);
        seen.add(id);
      }
    }
    const rest = collections.filter((c) => !seen.has(c.id));
    return [
      { title: "置顶", rows: pin },
      { title: "最近使用", rows: rec },
      { title: pin.length || rec.length ? "全部" : "", rows: rest },
    ].filter((s) => s.rows.length > 0);
  }, [collections, pinned, recent, q]);

  const iconBtn =
    "grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";

  const row = (c: Collection): ReactNode => {
    const isPinned = pinned.includes(c.id);
    const selected = String(c.id) === value;
    return (
      <div
        key={c.id}
        className={cn("group flex items-center gap-1 rounded-lg pr-1 transition-colors hover:bg-muted", selected && "bg-muted")}
      >
        <button
          type="button"
          role="option"
          aria-selected={selected}
          onClick={() => {
            onPick(c.id);
            close();
          }}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-3 py-2 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {isPinned ? <Pin className="size-3 shrink-0 text-primary" /> : null}
          <span className={cn("truncate", selected && "font-medium")}>{c.name}</span>
          <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{c.noteCount}</span>
        </button>
        <span className="flex shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100">
          <button
            type="button"
            aria-label={isPinned ? "取消置顶" : "置顶"}
            title={isPinned ? "取消置顶" : "置顶"}
            onClick={() => onTogglePin(c.id)}
            className={iconBtn}
          >
            {isPinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />}
          </button>
          <button
            type="button"
            aria-label="改名"
            title="改名"
            onClick={() => {
              close();
              onRename(c);
            }}
            className={iconBtn}
          >
            <Pencil className="size-3.5" />
          </button>
          <button
            type="button"
            aria-label="删除"
            title="删除库（笔记回到未分组）"
            onClick={() => {
              close();
              onDelete(c);
            }}
            className={cn(iconBtn, "hover:text-destructive")}
          >
            <Trash2 className="size-3.5" />
          </button>
        </span>
      </div>
    );
  };

  const submitNew = () => {
    const name = newName.trim();
    if (!name || creating) return;
    onCreate(name);
    close();
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setQ("");
          if (open) close();
          else setOpen(true);
        }}
        className={cn(
          "inline-flex items-center gap-2.5 rounded-xl border bg-background text-sm shadow-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
          compact ? "h-9 px-3" : "h-10 min-w-56 max-w-80 px-3.5",
          current
            ? "border-primary/60 text-foreground"
            : "border-border text-muted-foreground hover:border-(--color-border-strong) hover:text-foreground",
        )}
      >
        <FolderOpen className={cn("size-4 shrink-0", current && "text-primary")} />
        {current ? (
          <>
            <span className="truncate font-medium">{current.name}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{current.noteCount}</span>
          </>
        ) : (
          <>
            <span>{compact ? "全部库" : "选择采集库"}</span>
            {collections.length ? (
              <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{collections.length}</span>
            ) : null}
          </>
        )}
        <ChevronDown className={cn("size-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div className="absolute left-0 top-full z-30 mt-2 w-80 overflow-hidden rounded-xl border border-border bg-background shadow-lg">
          <div className="flex items-center gap-2 border-b border-border px-3.5 py-2.5">
            <Search className="size-4 text-muted-foreground" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索采集库…"
              aria-label="搜索采集库"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div role="listbox" className="max-h-80 overflow-y-auto p-1.5">
            {sections.length === 0 ? (
              <p className="px-3 py-5 text-center text-sm text-muted-foreground">
                {collections.length === 0 ? "还没有采集库" : "没有匹配的库"}
              </p>
            ) : (
              sections.map((s, i) => (
                <div key={s.title || "flat"} className={cn(i > 0 && "mt-1")}>
                  {s.title ? (
                    <p className="px-3 pb-1 pt-2 text-xs text-muted-foreground">{s.title}</p>
                  ) : null}
                  {s.rows.map(row)}
                </div>
              ))
            )}
          </div>
          <div className="border-t border-border p-1">
            {adding ? (
              <div className="flex items-center gap-1.5 p-1">
                <input
                  autoFocus
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submitNew();
                    if (e.key === "Escape") {
                      e.stopPropagation();
                      setAdding(false);
                    }
                  }}
                  placeholder="库名，如 健身"
                  maxLength={32}
                  aria-label="新库名"
                  className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
                <button
                  type="button"
                  disabled={!newName.trim() || creating}
                  onClick={submitNew}
                  className="h-9 rounded-lg bg-primary px-3.5 text-sm text-primary-foreground outline-none disabled:opacity-50"
                >
                  新建
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Plus className="size-4" />
                新建库
              </button>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
