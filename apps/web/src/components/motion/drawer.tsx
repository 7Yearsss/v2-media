"use client";
// beui.dev/components/motion/drawer

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { X } from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { EASE_OUT, SPRING_PANEL } from "@/lib/ease";
import { PresenceGate } from "@/lib/presence-gate";
import { cn } from "@/lib/utils";
import { useDialogFocus } from "@/lib/hooks/use-dialog-focus";

export interface DrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  side?: "left" | "right";
  children: ReactNode;
  /** Class for the panel surface. */
  className?: string;
  /** Class for the backdrop. */
  backdropClassName?: string;
  ariaLabel?: string;
  /** Close when the backdrop is clicked. Default true. */
  dismissable?: boolean;
  showCloseButton?: boolean;
}

export function Drawer({
  open,
  onOpenChange,
  side = "right",
  children,
  className,
  backdropClassName,
  ariaLabel,
  dismissable = true,
  showCloseButton = true,
}: DrawerProps) {
  const reduce = useReducedMotion();
  const dialog = useRef<HTMLElement>(null);
  useDialogFocus(open, dialog, () => onOpenChange(false));

  useEffect(() => {
    if (!open) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  const offscreen = side === "right" ? "100%" : "-100%";

  // Two fixed siblings, no wrapper: the backdrop spans the viewport edges but
  // paints the scrim, and the panel is inset off one side and paints its own
  // surface, so neither is a transparent edge-spanning layer. Both hang off
  // `PresenceGate`, so interaction releases in the same commit that starts the
  // exit rather than when it ends.
  return (
    <AnimatePresence>
      {open ? (
        <PresenceGate key="backdrop">
          {({ gate }) => (
            <motion.button
              type="button"
              aria-label="关闭面板"
              tabIndex={-1}
              onClick={() => dismissable && onOpenChange(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.25, ease: EASE_OUT }}
              {...gate}
              className={cn(
                "fixed inset-0 z-50 h-full w-full cursor-default bg-black/40 backdrop-blur-sm",
                backdropClassName,
              )}
            />
          )}
        </PresenceGate>
      ) : null}
      {open ? (
        <PresenceGate key="panel">
          {({ gate }) => (
            <motion.aside
              ref={dialog}
              tabIndex={-1}
              role="dialog"
              aria-modal="true"
              aria-label={ariaLabel}
              data-close-button={showCloseButton}
              initial={reduce ? { opacity: 0 } : { transform: `translateX(${offscreen})` }}
              animate={reduce ? { opacity: 1 } : { transform: "translateX(0%)" }}
              exit={reduce ? { opacity: 0 } : { transform: `translateX(${offscreen})` }}
              transition={
                reduce ? { duration: 0.2, ease: EASE_OUT } : SPRING_PANEL
              }
              {...gate}
              className={cn(
                "workspace-drawer fixed inset-y-0 z-50 flex w-80 max-w-[85vw] flex-col overflow-hidden rounded-[24px] border border-border bg-card shadow-[0_16px_48px_-16px_rgb(0_0_0_/_0.24)] sm:inset-y-2",
                side === "right"
                  ? "right-0 sm:right-2"
                  : "left-0 sm:left-2",
                className,
              )}
            >
              {children}
              {showCloseButton && <button type="button" aria-label={ariaLabel ? `关闭${ariaLabel}` : "关闭面板"} onClick={() => onOpenChange(false)} className="absolute right-3 top-3 z-10 grid size-9 place-items-center rounded-xl bg-card/90 text-muted-foreground hover:bg-muted hover:text-foreground"><X className="size-4" aria-hidden /></button>}
            </motion.aside>
          )}
        </PresenceGate>
      ) : null}
    </AnimatePresence>
  );
}
