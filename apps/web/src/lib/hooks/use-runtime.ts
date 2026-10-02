import { useQuery } from "@tanstack/react-query";
import { api } from "../api";

export function useRuntime() {
  const query = useQuery({ queryKey: ["server-runtime"], queryFn: api.runtime, staleTime: 60_000 });
  return { readOnly: query.data?.runtimeMode === "production-readonly", mode: query.data?.runtimeMode };
}
