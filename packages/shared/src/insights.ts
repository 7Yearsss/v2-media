import type { AccountPersonaSnapshot, CoverSpec, NoteImage, TopicScoreDetail } from "./types";

export type MetricsHorizon = "latest" | "1h" | "24h" | "7d";
export interface PostmortemCreateRequest { publishJobId: number; refresh?: boolean }
export interface InsightsQuery { accountId?: number; from?: number; to?: number; horizon?: MetricsHorizon; includePrivate?: "1"; offset?: number }
export interface PlanningSnapshot {
  version: 1; topicId: number; title: string; score: number | null; scoreDetail: TopicScoreDetail | null;
  scoreMethod: string | null; scoreModel: string | null; scoredAt: string | null;
  accountId: number | null; persona: AccountPersonaSnapshot | null;
}
export const METRIC_FIELDS = ["likes", "collects", "comments", "shares", "views", "exposure"] as const;
export type MetricField = typeof METRIC_FIELDS[number];
export type MetricValues = Record<MetricField, number | null>;
export interface InsightMetric extends MetricValues {
  id: number; capturedAt: string; scheduledFor: string | null; delayMs: number | null;
  ageMs: number | null; source: string; interactions: number | null;
}
export interface InsightNote {
  publishJobId: number; accountId: number; accountName: string; title: string; noteId: string | null;
  visibility: string; outcome: string | null; createdAt: string; publishedAt: string | null;
  reportedAt: string | null; verifiedAt: string | null; contentSource: "frozen" | "current_draft";
  planning: PlanningSnapshot | null; metric: InsightMetric | null;
}
export interface InsightAccountPoint {
  id: number; capturedAt: string; followers: number | null; likesTotal: number | null; notesCount: number | null;
}
export interface CalibrationGroup {
  accountId: number; accountName: string; scoreMethod: string; scoreModel: string; scoreBand: string;
  count: number; medianScore: number; medianTraffic: number | null; medianInteractions: number;
  medianViews: number | null; medianExposure: number | null; viewsCount: number; exposureCount: number;
  minAgeMs: number; maxAgeMs: number;
}
export interface InsightsOverview {
  notesCount: number; sampledCount: number; excludedPrivate: number; excludedDuplicate: number;
  missingMetrics: number; totals: MetricValues; coverage: Record<MetricField, number>;
  accounts: Array<{ accountId: number; nickname: string; points: InsightAccountPoint[] }>;
  calibration: { horizon: MetricsHorizon; eligibleCount: number; exclusions: Record<string, number>; groups: CalibrationGroup[]; message: string };
}
export interface InsightsNotesPage { items: InsightNote[]; total: number; nextOffset: number | null }
export interface PostmortemEvidence {
  note: InsightNote; content: { title: string; content: string; tags: string[]; images: NoteImage[] };
  cover: CoverSpec | null; persona: AccountPersonaSnapshot | null; metrics: InsightMetric[]; gaps: string[];
}
export interface PostmortemInsight {
  evidence: Array<{ metricIds: number[]; observation: string }>;
  hypotheses: Array<{ metricIds: number[]; possibleReason: string; limitation: string }>;
  experiments: Array<{ change: string; observe: string }>;
}
export interface PostmortemReport {
  engine: "ai" | "data_only" | null;
  id: number; publishJobId: number; status: "queued" | "running" | "done" | "failed";
  model: string; promptVersion: string; evidence: PostmortemEvidence; insight: PostmortemInsight | null;
  error: string | null; createdAt: string; finishedAt: string | null;
}
export interface InsightNoteDetail { note: InsightNote; evidence: PostmortemEvidence; reports: PostmortemReport[] }
