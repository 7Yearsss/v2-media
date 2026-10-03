import { useId, useRef, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/motion/button";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/lib/hooks/use-dialog-focus";
import { PresenceGate } from "@/lib/presence-gate";

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
  const dialog = useRef<HTMLDivElement>(null), uid = useId();
  useDialogFocus(open, dialog, () => onOpenChange(false));

  return (
    <AnimatePresence>
      {open ? (
        <PresenceGate>{({ gate }) => <div {...gate} className="fixed inset-0 z-50 grid place-items-center p-4">
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
            ref={dialog}
            tabIndex={-1}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby={`${uid}-title`}
            aria-describedby={description ? `${uid}-description` : undefined}
            initial={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 8 }}
            animate={reduce ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
            transition={{ duration: reduce ? 0.1 : 0.18, ease: EASE_OUT }}
            className="relative max-h-[calc(100dvh-32px)] w-full max-w-sm overflow-y-auto rounded-3xl border border-border bg-card p-6 shadow-[0_24px_80px_-24px_rgb(0_0_0_/_0.3)]"
          >
            <h2 id={`${uid}-title`} className="text-lg font-semibold tracking-tight">{title}</h2>
            {description ? <p id={`${uid}-description`} className="mt-2 text-sm leading-6 text-muted-foreground">{description}</p> : null}
            {children ? <div className="mt-3">{children}</div> : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button size="sm" variant="outline" data-dialog-autofocus={children ? undefined : true} onClick={() => onOpenChange(false)}>
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
        </div>}</PresenceGate>
      ) : null}
    </AnimatePresence>
  );
}
