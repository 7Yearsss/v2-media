export type WorkspaceTaskFilter = "active" | "attention" | "all";
export type WorkspaceTaskBucket = "active" | "attention" | "completed";
export type WorkspaceTaskSource = "ai_run" | "job" | "publish" | "collection";
export type WorkspaceTaskState = "queued" | "running" | "paused" | "blocked" | "partial" | "done" | "failed" | "canceled" | "unknown";
export interface WorkspaceTasksQuery { filter?: WorkspaceTaskFilter; accountId?: number | null }
/** Observation only: no frozen input, payload, provider error, credential or execution lease. */
export interface WorkspaceTask {
  key: string;
  id: number;
  source: WorkspaceTaskSource;
  kind: string;
  label: string;
  state: WorkspaceTaskState;
  rawStatus: string;
  bucket: WorkspaceTaskBucket;
  stage: string;
  description: string;
  account: { id: number; nickname: string; archived: boolean } | null;
  object: { type: "analysis" | "collection" | "topic" | "draft" | "publication" | "account"; id: number; title: string; archived: boolean } | null;
  /** Relative application URL; actions are handled by the owning domain page. */
  href: string;
  actionLabel: string;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  nextCheckAt: string | null;
  nextCheckKind: "scheduled" | "retry" | "lease" | null;
}
export interface WorkspaceTaskRange {
  source: WorkspaceTaskSource;
  bucket: WorkspaceTaskBucket;
  total: number;
  returned: number;
  truncated: boolean;
}
export interface WorkspaceTasksResponse {
  items: WorkspaceTask[];
  observedAt: string;
  filter: WorkspaceTaskFilter;
  accountId: number | null;
  counts: Record<WorkspaceTaskBucket, number>;
  ranges: WorkspaceTaskRange[];
  /** Each source/bucket is capped separately, so completions cannot hide active or failed work. */
  perSourceBucketLimit: number;
  truncated: boolean;
  /** Due/running work refreshes at 5s; future-only queues at 30s; no automatic work returns null. */
  refreshAfterMs: number | null;
}
