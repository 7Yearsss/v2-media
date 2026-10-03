import { useEffect, useRef, type RefObject } from "react";

const dialogs: HTMLElement[] = [];
const controls = "a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]";
const visibleControls = (root: HTMLElement) => Array.from(root.querySelectorAll<HTMLElement>(controls))
  .filter(element => element.tabIndex >= 0 && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden" && !element.closest("[inert]"));

/** Only the top dialog owns focus; closing restores its original trigger. */
export function useDialogFocus(open: boolean, ref: RefObject<HTMLElement | null>, onClose: () => void) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const root = ref.current;
    if (!open || !root) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogs.push(root);
    const isTop = () => dialogs.at(-1) === root;
    const focusStart = () => (root.querySelector<HTMLElement>("[data-dialog-autofocus]") ?? visibleControls(root)[0] ?? root).focus({ preventScroll: true });
    const frame = requestAnimationFrame(() => { if (isTop()) focusStart(); });
    const onKey = (event: KeyboardEvent) => {
      if (!isTop() || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault(); event.stopPropagation(); close.current(); return;
      }
      if (event.key !== "Tab") return;
      const items = visibleControls(root), first = items[0], last = items.at(-1);
      if (!first || !last) { event.preventDefault(); root.focus(); return; }
      if (!root.contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault(); (event.shiftKey ? last : first).focus();
      }
    };
    const onFocus = (event: FocusEvent) => { if (isTop() && !root.contains(event.target as Node)) focusStart(); };
    document.addEventListener("keydown", onKey);
    document.addEventListener("focusin", onFocus);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("focusin", onFocus);
      const ownedFocus = isTop();
      const index = dialogs.indexOf(root);
      if (index !== -1) dialogs.splice(index, 1);
      if (ownedFocus && previous?.isConnected && !previous.closest("[inert]")) previous.focus({ preventScroll: true });
    };
  }, [open, ref]);
}
