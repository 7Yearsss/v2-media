import { QueryClientProvider } from "@tanstack/react-query";
import { useSyncExternalStore, type ReactNode } from "react";
import { sessionQueryScope } from "./session-query-scope";

export function SessionQueryProvider({ children }: { children: ReactNode }) {
  const { epoch, client } = useSyncExternalStore(sessionQueryScope.subscribe, sessionQueryScope.getSnapshot);
  // Remount local editors, mutation observers, routes and toasts as one session.
  return <QueryClientProvider key={epoch} client={client}>{children}</QueryClientProvider>;
}
