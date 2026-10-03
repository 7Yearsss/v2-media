import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ContentLink { label: string; to: string }

/** Only pass relations confirmed by an owned API response; missing relations stay absent. */
export function ContentLinks({ items, current, className }: {
  items: ContentLink[]; current?: string; className?: string;
}) {
  if (!items.length) return null;
  return <nav aria-label="内容关系" className={cn("flex flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-6", className)}>
    {items.map((item, index) => <span key={`${item.to}-${index}`} className="inline-flex min-w-0 items-center gap-2">
      {index > 0 && <ChevronRight aria-hidden="true" className="size-3 shrink-0 text-muted-foreground" />}
      <Link to={item.to} className="rounded text-muted-foreground outline-none hover:text-primary hover:underline focus-visible:ring-2 focus-visible:ring-ring">{item.label}</Link>
    </span>)}
    {current && <span aria-current="page" className="inline-flex items-center gap-2 text-foreground">
      {items.length > 0 && <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />}{current}
    </span>}
  </nav>;
}
