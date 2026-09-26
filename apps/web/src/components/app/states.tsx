import type { LucideIcon } from "lucide-react";
import { Inbox, RotateCcw, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { Loader } from "@/components/motion/loader";
import { Button } from "@/components/motion/button";
import { cn } from "@/lib/utils";

export function PageLoading({
  label = "加载中…",
  className,
}: {
  label?: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground",
        className,
      )}
    >
      <Loader variant="dots" size={28} label={label} />
      <p className="text-sm">{label}</p>
    </div>
  );
}

export function PageError({
  error,
  onRetry,
  className,
}: {
  error?: unknown;
  onRetry?: () => void;
  className?: string;
}) {
  const message =
    error instanceof Error ? error.message : "加载失败，请稍后重试";
  return (
    <div
      className={cn(
        "flex min-h-48 flex-col items-center justify-center gap-3 text-center",
        className,
      )}
    >
      <div className="grid size-11 place-items-center rounded-2xl border border-destructive/30 bg-destructive/10 text-destructive">
        <TriangleAlert className="size-5" />
      </div>
      <p className="text-sm font-medium text-foreground">{message}</p>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCcw className="size-3.5" />
          重试
        </Button>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon = Inbox,
  title,
  description,
  action,
  className,
}: {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-h-48 flex-col items-center justify-center gap-3 text-center",
        className,
      )}
    >
      <div className="grid size-11 place-items-center rounded-2xl border border-border bg-card text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <p className="text-sm font-medium text-foreground">{title}</p>
      {description ? (
        <p className="max-w-xs text-xs leading-5 text-muted-foreground">
          {description}
        </p>
      ) : null}
      {action}
    </div>
  );
}
