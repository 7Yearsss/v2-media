import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ReactNode,
} from "react";
import {
  AnimatedToastStack,
  useAnimatedToastStack,
  type ToastInput,
} from "@/components/motion/animated-toast-stack";

interface ToastApi {
  toast: (input: ToastInput) => string;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
  update: (id: string, patch: Partial<ToastInput>) => void;
  dismiss: (id: string) => void;
}

const ToastCtx = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { toasts, showToast, updateToast, dismissToast } =
    useAnimatedToastStack({ defaultDuration: 4200, limit: 5 });

  const simple = useCallback(
    (status: ToastInput["status"]) =>
      (title: string, description?: string) =>
        showToast({ title, description, status }),
    [showToast],
  );

  const api = useMemo<ToastApi>(
    () => ({
      toast: showToast,
      success: simple("success"),
      error: simple("error"),
      info: simple("info"),
      update: updateToast,
      dismiss: dismissToast,
    }),
    [showToast, simple, updateToast, dismissToast],
  );

  return (
    <ToastCtx.Provider value={api}>
      {children}
      <AnimatedToastStack
        toasts={toasts}
        onDismiss={dismissToast}
        position="bottom-right"
        fixed
      />
    </ToastCtx.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastCtx);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider>");
  return ctx;
}
