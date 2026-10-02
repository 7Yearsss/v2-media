export type AiRunKind = "analysis" | "topic_generate" | "topic_score";
export type AiRunStatus = "queued" | "running" | "done" | "failed" | "canceled";
export interface AiRunRetryRequest { operationId: string }
export interface AiRunProgress { steps: string[]; at: string }
export type AiRunResult =
  | { analysisId: number; collectionId: number }
  | { collectionId: number; topicIds: number[]; count: number }
  | { topicId: number; score: number; verdict: string; advice: string };
/** Public run state. Frozen raw input, provider credentials and leases never appear here. */
export interface AiRun {
  id: number;
  kind: AiRunKind;
  targetType: "analysis" | "collection" | "topic";
  targetId: number;
  model: string;
  promptVersion: string;
  status: AiRunStatus;
  stage: string;
  progress: AiRunProgress | null;
  attempt: number;
  maxAttempts: number;
  result: AiRunResult | null;
  errorCode: string | null;
  errorMessage: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}
