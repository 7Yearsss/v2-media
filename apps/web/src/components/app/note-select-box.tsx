import { Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** 卡片 / 行左上角的多选框；点击不冒泡到"打开详情"。 */
export function NoteSelectBox({
  checked,
  label,
  onToggle,
  className,
}: {
  checked: boolean;
  label: string;
  /** range=true：按住 Shift 点击，连选一段。 */
  onToggle: (range?: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.shiftKey);
      }}
      onKeyDown={(e) => e.stopPropagation()}
      className={cn(
        "grid size-6 place-items-center rounded-md border shadow-sm outline-none transition-opacity focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring",
        checked
          ? "border-primary bg-primary text-primary-foreground"
          : "border-white/80 bg-black/35 text-transparent backdrop-blur-sm hover:bg-black/55",
        className,
      )}
    >
      <Check className="size-3.5" strokeWidth={3} />
    </button>
  );
}
