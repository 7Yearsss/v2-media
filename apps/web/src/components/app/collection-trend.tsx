import { useState } from "react";
import { cn } from "@/lib/utils";
import { formatCount } from "@/lib/format";

/** Daily counts, never normalized shares. Every value is also a keyboard target. */
export function CollectionTrend({ points }: { points: { label: string; count: number }[] }) {
  const [inspected, setInspected] = useState<string | null>(null);
  const active = Math.max(0, points.findIndex(point => point.label === inspected));
  const selected = inspected === null ? points.length - 1 : active;
  const point = points[selected];
  const total = points.reduce((sum, item) => sum + item.count, 0);
  const max = Math.max(1, ...points.map(item => item.count));
  const step = 10 ** Math.floor(Math.log10(max));
  const ceiling = Math.ceil(max / step) * step;
  if (!point) return null;

  return <div className="space-y-5">
    <div className="flex items-baseline justify-between gap-4">
      <p className="text-sm text-muted-foreground"><span className="mr-2 text-2xl font-semibold tabular-nums tracking-tight text-foreground">{formatCount(total)}</span>条</p>
      <p className="text-xs tabular-nums text-muted-foreground">{point.label}<span className="ml-3 font-medium text-foreground">{formatCount(point.count)} 条</span></p>
    </div>
    <div className="relative pl-7">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 left-0 flex flex-col justify-between pb-10 text-[11px] tabular-nums text-muted-foreground"><span>{formatCount(ceiling)}</span><span>0</span></div>
      <div className="grid gap-1 sm:gap-3" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
        {points.map((item, index) => <button key={item.label} type="button" aria-label={`${item.label}，采集 ${item.count} 条`} aria-pressed={index === selected}
          onPointerEnter={() => setInspected(item.label)} onFocus={() => setInspected(item.label)} onClick={() => setInspected(item.label)}
          className="group min-w-0 rounded-lg text-center outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <span className={cn("relative flex h-36 items-end justify-center overflow-hidden rounded-lg border-b border-border bg-muted/30 px-1 sm:h-40", index === selected && "bg-primary/[0.06]")}>
            <span aria-hidden className="absolute inset-x-0 top-1/2 border-t border-dashed border-border/60" />
            <span aria-hidden className={cn("relative w-full max-w-10 rounded-t-[6px] bg-primary/75 group-hover:bg-primary/90", index === selected && "bg-primary")}
              style={{ height: `${item.count / ceiling * 90}%`, minHeight: item.count > 0 ? 3 : 0 }} />
            {item.count === 0 && <span aria-hidden className="relative mb-1 size-1 rounded-full bg-muted-foreground/40" />}
          </span>
          <span className={cn("mt-3 block truncate pb-1 text-[11px] tabular-nums text-muted-foreground sm:text-xs", index === selected && "font-medium text-foreground")}>{item.label}</span>
        </button>)}
      </div>
    </div>
  </div>;
}
