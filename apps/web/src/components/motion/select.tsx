"use client";
// Adapted from beui.dev/components/motion/select for stable keyboard selection.

import { Check, ChevronDown } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";

type Placement = "top" | "bottom";
interface SelectContextValue {
  value: string | undefined; open: boolean; disabled: boolean;
  setOpen: (open: boolean) => void; select: (value: string) => void;
  register: (value: string, label: string) => void; unregister: (value: string) => void;
  labelFor: (value: string | undefined) => string | undefined;
  triggerId: string; listId: string; placement: Placement; setPlacement: (value: Placement) => void;
}
const SelectContext = createContext<SelectContextValue | null>(null);
function useSelectContext(component: string) {
  const context = useContext(SelectContext);
  if (!context) throw new Error(`${component} must be used within <Select>`);
  return context;
}
export interface SelectProps {
  value?: string; defaultValue?: string; onValueChange?: (value: string) => void;
  open?: boolean; defaultOpen?: boolean; onOpenChange?: (open: boolean) => void;
  disabled?: boolean; className?: string; children: ReactNode;
}
export function Select({ value, defaultValue, onValueChange, open: controlledOpen, defaultOpen = false, onOpenChange, disabled = false, className, children }: SelectProps) {
  const uid = useId(), root = useRef<HTMLDivElement>(null), focusLast = useRef(false);
  const typeahead = useRef({ text: "", at: 0 });
  const [internalOpen, setInternalOpen] = useState(defaultOpen), [internalValue, setInternalValue] = useState(defaultValue);
  const [labels, setLabels] = useState<Map<string, string>>(new Map()), [placement, setPlacement] = useState<Placement>("bottom");
  const open = controlledOpen ?? internalOpen, current = value ?? internalValue;
  const setOpen = useCallback((next: boolean) => {
    if (controlledOpen === undefined) setInternalOpen(next);
    onOpenChange?.(next);
  }, [controlledOpen, onOpenChange]);
  const select = useCallback((next: string) => {
    if (value === undefined) setInternalValue(next);
    onValueChange?.(next);
    setOpen(false);
    document.getElementById(`${uid}-trigger`)?.focus({ preventScroll: true });
  }, [value, onValueChange, setOpen, uid]);
  const register = useCallback((key: string, label: string) => setLabels(current => current.get(key) === label ? current : new Map(current).set(key, label)), []);
  const unregister = useCallback((key: string) => setLabels(current => { if (!current.has(key)) return current; const next = new Map(current); next.delete(key); return next; }), []);
  const options = () => Array.from(root.current?.querySelectorAll<HTMLButtonElement>("[role='option']:not([disabled])") ?? []);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const items = options(), selected = items.find(item => item.getAttribute("aria-selected") === "true");
      (selected ?? (focusLast.current ? items.at(-1) : items[0]))?.focus({ preventScroll: true });
    });
    const onPointer = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("pointerdown", onPointer, true);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("pointerdown", onPointer, true); };
  }, [open, setOpen]);

  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || event.defaultPrevented) return;
    if (event.key === "Escape" && open) {
      event.preventDefault(); event.stopPropagation(); setOpen(false);
      document.getElementById(`${uid}-trigger`)?.focus({ preventScroll: true }); return;
    }
    if (event.key === "Tab" && open) { setOpen(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault(); event.stopPropagation();
      if (!open) { focusLast.current = event.key === "ArrowUp" || event.key === "End"; setOpen(true); return; }
      const items = options(), index = items.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : Math.max(0, Math.min(items.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      items[next]?.focus(); return;
    }
    if (open && event.key.length === 1 && event.key !== " " && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const now = performance.now(), text = (now - typeahead.current.at < 600 ? typeahead.current.text : "") + event.key.toLowerCase();
      typeahead.current = { text, at: now };
      const match = options().find(item => item.textContent?.trim().toLowerCase().startsWith(text));
      if (match) { event.preventDefault(); match.focus(); }
    }
  };
  const context = useMemo<SelectContextValue>(() => ({ value: current, open, disabled, setOpen, select, register, unregister,
    labelFor: key => key === undefined ? undefined : labels.get(key), triggerId: `${uid}-trigger`, listId: `${uid}-list`, placement, setPlacement }),
    [current, open, disabled, setOpen, select, register, unregister, labels, uid, placement]);
  return <SelectContext.Provider value={context}><div ref={root} onKeyDown={onKey} className={cn("relative", className)}>{children}</div></SelectContext.Provider>;
}
export interface SelectTriggerProps { className?: string; children: ReactNode }
export function SelectTrigger({ className, children }: SelectTriggerProps) {
  const context = useSelectContext("SelectTrigger");
  return <button type="button" id={context.triggerId} disabled={context.disabled} aria-haspopup="listbox" aria-expanded={context.open} aria-controls={context.listId}
    onClick={() => context.setOpen(!context.open)}
    className={cn("relative z-10 flex w-full items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground outline-none transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50", className)}>
    {children}<ChevronDown aria-hidden className={cn("size-4 shrink-0 text-muted-foreground", context.open && "rotate-180")} />
  </button>;
}
export interface SelectValueProps { placeholder?: string; className?: string }
export function SelectValue({ placeholder, className }: SelectValueProps) {
  const context = useSelectContext("SelectValue");
  return <span className={cn("min-w-0 flex-1 truncate text-left", className)}>{context.labelFor(context.value) ?? placeholder ?? "选择"}</span>;
}
export interface SelectContentProps { className?: string; children: ReactNode }
export function SelectContent({ className, children }: SelectContentProps) {
  const context = useSelectContext("SelectContent"), panel = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!context.open) return;
    const trigger = document.getElementById(context.triggerId), content = panel.current;
    if (!trigger || !content) return;
    const rect = trigger.getBoundingClientRect(), below = window.innerHeight - rect.bottom;
    context.setPlacement(below < content.offsetHeight + 16 && rect.top > below ? "top" : "bottom");
  }, [context.open, context.triggerId, context.setPlacement]);
  return <div ref={panel} id={context.listId} role="listbox" aria-labelledby={context.triggerId} hidden={!context.open} inert={!context.open}
    className={cn("absolute left-0 right-0 z-30 max-h-72 overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-1.5 shadow-[0_8px_28px_-12px_rgb(0_0_0_/_0.24)]", context.placement === "top" ? "bottom-full mb-2" : "top-full mt-2", className)}>{children}</div>;
}
export interface SelectItemProps { value: string; disabled?: boolean; className?: string; children: ReactNode }
export function SelectItem({ value, disabled, className, children }: SelectItemProps) {
  const context = useSelectContext("SelectItem"), selected = context.value === value;
  const item = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    context.register(value, item.current?.textContent?.trim() || value);
    return () => context.unregister(value);
  }, [context.register, context.unregister, value, children]);
  return <button ref={item} type="button" role="option" aria-selected={selected} disabled={disabled} tabIndex={context.open ? 0 : -1} onClick={() => context.select(value)}
    className={cn("flex min-h-9 w-full items-center justify-between gap-2 rounded-xl px-2.5 py-2 text-left text-sm outline-none hover:bg-muted focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50", selected ? "bg-muted font-medium text-foreground" : "text-muted-foreground", className)}>
    {children}{selected && <Check aria-hidden className="size-3.5 shrink-0" />}
  </button>;
}
