import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { WorkspaceTasksQuery } from "@v2media/shared";
import { api, captureSession } from "../api";

export function useTaskCenter(open: boolean, scope: WorkspaceTasksQuery = {}) {
  const session = useMemo(captureSession, []);
  const [available, setAvailable] = useState(() => document.visibilityState === "visible" && navigator.onLine);
  useEffect(() => {
    const update = () => setAvailable(document.visibilityState === "visible" && navigator.onLine);
    document.addEventListener("visibilitychange", update);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      document.removeEventListener("visibilitychange", update);
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);
  const enabled = open && available;
  const query = useQuery({
    queryKey: ["workspace-tasks", session.epoch, scope.filter ?? "all", scope.accountId ?? null],
    queryFn: () => api.workspaceTasks(scope, session),
    enabled,
    staleTime: 0,
    retry: false,
    refetchOnWindowFocus: enabled,
    refetchOnReconnect: enabled,
    refetchInterval: q => enabled && !q.state.error ? q.state.data?.refreshAfterMs ?? false : false,
    refetchIntervalInBackground: false,
  });
  return { ...query, available };
}
