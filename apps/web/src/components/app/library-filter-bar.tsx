import { X } from "lucide-react";
import type { NoteRangeFilter } from "@/lib/api";
import { FilterSelect } from "@/components/app/filter-select";
import { formatCount } from "@/lib/format";
import { cn } from "@/lib/utils";

export const LIKE_OPTIONS = [0, 500, 1000, 3000, 10000] as const;
export const DAYS_OPTIONS = [0, 7, 30, 90] as const;
const TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "image", label: "图文" },
  { value: "video", label: "视频" },
] as const;

/** 已选范围条件（传给 api.notes 的形状）；空值 = 不限。 */
export function rangeFilterActive(f: NoteRangeFilter): boolean {
  return Boolean(f.type || f.minLikes || f.withinDays);
}

export function LibraryFilterBar({
  value,
  onChange,
}: {
  value: NoteRangeFilter;
  onChange: (next: NoteRangeFilter) => void;
}) {
  const chips: Array<{ key: keyof NoteRangeFilter; label: string }> = [];
  if (value.type) chips.push({ key: "type", label: value.type === "video" ? "视频" : "图文" });
  if (value.minLikes) chips.push({ key: "minLikes", label: `点赞 ≥ ${formatCount(value.minLikes)}` });
  if (value.withinDays) chips.push({ key: "withinDays", label: `近 ${value.withinDays} 天发布` });

  return (
    <div className="flex flex-wrap items-center gap-2">
      <FilterSelect
        value={value.type ?? ""}
        onChange={(v) => onChange({ ...value, type: (v || undefined) as NoteRangeFilter["type"] })}
        options={TYPE_OPTIONS}
        className="w-28"
      />
      <FilterSelect
        value={String(value.minLikes ?? 0)}
        onChange={(v) => onChange({ ...value, minLikes: Number(v) || undefined })}
        options={LIKE_OPTIONS.map((n) => ({ value: String(n), label: n ? `点赞 ≥ ${formatCount(n)}` : "点赞不限" }))}
        className="w-32"
      />
      <FilterSelect
        value={String(value.withinDays ?? 0)}
        onChange={(v) => onChange({ ...value, withinDays: Number(v) || undefined })}
        options={DAYS_OPTIONS.map((n) => ({ value: String(n), label: n ? `近 ${n} 天发布` : "发布时间不限" }))}
        className="w-36"
      />
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onChange({ ...value, [c.key]: undefined })}
          className={cn(
            "inline-flex h-7 items-center gap-1 rounded-full bg-primary/10 pl-2.5 pr-1.5 text-xs text-primary outline-none",
            "hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring",
          )}
          aria-label={`清除筛选：${c.label}`}
        >
          {c.label}
          <X className="size-3" />
        </button>
      ))}
      {chips.length > 1 ? (
        <button
          type="button"
          onClick={() => onChange({})}
          className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          清除全部
        </button>
      ) : null}
    </div>
  );
}
