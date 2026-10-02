import { QueryClient } from "@tanstack/react-query";
import { captureSession, getSessionSnapshot, SessionChangedError, subscribeSession } from "./session";

/** A retired client cannot expose its query or mutation data to the next login. */
export function createSessionQueryScope() {
  const createSnapshot = () => ({ epoch: getSessionSnapshot().epoch, client: new QueryClient({
    defaultOptions: {
      queries: {
        retry: (count, error) => !(error instanceof SessionChangedError) && count < 1,
        refetchOnWindowFocus: false,
        staleTime: 10_000,
      },
    },
  }) });
  captureSession();
  let snapshot = createSnapshot();
  const listeners = new Set<() => void>();
  const stop = subscribeSession(() => {
    const previous = snapshot.client;
    snapshot = createSnapshot();
    void previous.cancelQueries().catch(() => {});
    previous.clear(); // Includes the mutation cache, even for still-pending mutations.
    for (const notify of [...listeners]) notify();
  });
  return {
    getSnapshot: () => snapshot,
    subscribe: (notify: () => void) => {
      listeners.add(notify);
      return () => { listeners.delete(notify); };
    },
    dispose: () => { stop(); void snapshot.client.cancelQueries().catch(() => {}); snapshot.client.clear(); listeners.clear(); },
  };
}

export const sessionQueryScope = createSessionQueryScope();
