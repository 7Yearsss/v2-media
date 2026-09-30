import { useState } from "react";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

export function NoteAvatar({ name, src, className }: { name: string; src?: string; className?: string }) {
  const [failed, setFailed] = useState<string>();
  const url = mediaUrl(src);
  return <span className={cn("grid size-8 shrink-0 place-items-center overflow-hidden rounded-full bg-muted text-[11px] text-muted-foreground", className)}>
    {url && failed !== url ? <img src={url} alt={`${name || "用户"}的头像`} loading="lazy" decoding="async" className="h-full w-full object-cover" onError={() => setFailed(url)} /> : Array.from(name || "?")[0]}
  </span>;
}
