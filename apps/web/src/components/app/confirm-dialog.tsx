import { useEffect, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/motion/button";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

/**
 * 居中确认弹窗，替代 window.confirm / window.prompt。
 * children 可放输入框（重命名场景）；Esc / 点遮罩取消。
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确定",
  destructive,
  confirmDisabled,
  busy,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  destructive?: boolean;
  confirmDisabled?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onOpenChange]);

  return (
    <AnimatePresence>
      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <motion.button
            type="button"
            aria-label="取消"
            tabIndex={-1}
            onClick={() => onOpenChange(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2, ease: EASE_OUT }}
            className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-sm"
          />
          <motion.div
            role="alertdialog"
            aria-modal="true"
            aria-label={title}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={reduce ? { duration: 0.15 } : { type: "spring", duration: 0.35, bounce: 0.15 }}
            className="relative w-full max-w-sm rounded-2xl border border-border bg-background p-5 shadow-2xl"
          >
            <h2 className="text-base font-semibold">{title}</h2>
            {description ? <p className="mt-1.5 text-sm text-muted-foreground">{description}</p> : null}
            {children ? <div className="mt-3">{children}</div> : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>
                取消
              </Button>
              <Button
                size="sm"
                variant={destructive ? "outline" : "secondary"}
                disabled={confirmDisabled || busy}
                onClick={onConfirm}
                className={cn(destructive && "text-destructive hover:text-destructive")}
              >
                {confirmLabel}
              </Button>
            </div>
          </motion.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
