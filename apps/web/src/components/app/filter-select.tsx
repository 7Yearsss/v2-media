import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/motion/select";
import { cn } from "@/lib/utils";

export interface FilterSelectOption {
  value: string;
  label: string;
}

/** 紧凑型 beUI Select（工具栏筛选/排序用）：h-8 触发器，面板宽度可独立指定。 */
export function FilterSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
  panelClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  options: readonly FilterSelectOption[];
  placeholder?: string;
  disabled?: boolean;
  /** 外层宽度，如 w-32 */
  className?: string;
  /** 下拉面板宽度覆盖，如 right-auto w-48（选项文字比触发器长时用） */
  panelClassName?: string;
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled} className={cn("w-32 shrink-0 has-[[aria-expanded=true]]:z-30", className)}>
      <SelectTrigger className="h-9 rounded-lg px-2.5 py-0 text-xs">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={cn("text-xs", panelClassName)}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} className="text-xs">
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
