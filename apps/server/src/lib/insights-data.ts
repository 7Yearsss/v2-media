import { and, asc, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { METRIC_FIELDS, type InsightMetric, type InsightNote, type InsightsQuery, type MetricsHorizon, type PostmortemEvidence, type CalibrationGroup } from "@v2media/shared";
import type { Db } from "../db";
import { accountSnapshots, drafts, hostedAccounts, noteMetrics, publishJobs } from "../db/schema";

const HOUR = 3_600_000;
export const SAMPLE_WINDOWS = { "1h": [HOUR, 2 * HOUR], "24h": [24 * HOUR, 48 * HOUR], "7d": [168 * HOUR, 192 * HOUR] } as const;
export function metricPoint(row: typeof noteMetrics.$inferSelect, publishedAt: Date | null): InsightMetric {
  const values = Object.fromEntries(METRIC_FIELDS.map(k => [k, typeof row[k] === "number" && row[k]! >= 0 ? row[k] : null])) as Pick<InsightMetric, typeof METRIC_FIELDS[number]>;
  const scheduled = typeof row.extra?.scheduledFor === "string" && Number.isFinite(Date.parse(row.extra.scheduledFor)) ? row.extra.scheduledFor : null;
  return { ...values, id: row.id, capturedAt: row.capturedAt.toISOString(), scheduledFor: scheduled,
    delayMs: scheduled ? Math.max(0, row.capturedAt.getTime() - Date.parse(scheduled)) : null,
    ageMs: publishedAt ? row.capturedAt.getTime() - publishedAt.getTime() : null,
    source: typeof row.extra?.source === "string" && /^[a-z_]{1,40}$/.test(row.extra.source) ? row.extra.source : "unknown",
    interactions: [values.likes, values.collects, values.comments, values.shares].every(v => v !== null)
      ? values.likes! + values.collects! + values.comments! + values.shares! : null };
}
export function selectMetric(points: InsightMetric[], horizon: MetricsHorizon) {
  const ordered = [...points].sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || a.id - b.id);
  if (horizon === "latest") return ordered.at(-1) ?? null;
  const [start, end] = SAMPLE_WINDOWS[horizon];
  return ordered.find(p => p.ageMs !== null && p.ageMs >= start && p.ageMs < end) ?? null;
}
const iso = (d: Date | null) => d?.toISOString() ?? null;
function noteSummary(job: typeof publishJobs.$inferSelect, draft: typeof drafts.$inferSelect, nickname: string, points: InsightMetric[], horizon: MetricsHorizon): InsightNote {
  return { publishJobId: job.id, accountId: job.accountId, accountName: nickname, title: job.draftSnapshot?.title ?? draft.title,
    noteId: job.noteId, visibility: job.visibility, outcome: job.outcome, createdAt: job.createdAt.toISOString(),
    publishedAt: iso(job.publishedAt), reportedAt: iso(job.reportedAt), verifiedAt: iso(job.verifiedAt),
    planning: job.planningSnapshot, contentSource: job.draftSnapshot ? "frozen" : "current_draft", metric: selectMetric(points, horizon) };
}

export async function loadInsights(db: Db, userId: number, query: InsightsQuery) {
  const filters = [eq(publishJobs.userId, userId), eq(publishJobs.status, "done")];
  if (query.accountId) filters.push(eq(publishJobs.accountId, query.accountId));
  if (query.from !== undefined) filters.push(gte(publishJobs.createdAt, new Date(query.from)));
  if (query.to !== undefined) filters.push(lte(publishJobs.createdAt, new Date(query.to)));
  const rows = await db.select({ job: publishJobs, draft: drafts, nickname: hostedAccounts.nickname }).from(publishJobs)
    .innerJoin(drafts, and(eq(drafts.id, publishJobs.draftId), eq(drafts.userId, userId)))
    .innerJoin(hostedAccounts, and(eq(hostedAccounts.id, publishJobs.accountId), eq(hostedAccounts.userId, userId)))
    .where(and(...filters)).orderBy(asc(publishJobs.id));
  const metrics = rows.length ? await db.select().from(noteMetrics).where(and(eq(noteMetrics.userId, userId), inArray(noteMetrics.publishJobId, rows.map(r => r.job.id)))) : [];
  const byJob = new Map<number, InsightMetric[]>();
  const byId = new Map(rows.map(r => [r.job.id, r.job]));
  for (const metric of metrics) {
    const job = byId.get(metric.publishJobId!);
    if (!job || !job.noteId || job.noteId !== metric.noteId || job.outcome !== "verified") continue;
    const points = byJob.get(job.id) ?? [];
    points.push(metricPoint(metric, job.publishedAt)); byJob.set(job.id, points);
  }
  const seen = new Set<string>(); let excludedDuplicate = 0, excludedPrivate = 0;
  const notes: InsightNote[] = [];
  for (const row of rows) {
    if (query.includePrivate !== "1" && row.job.visibility !== "public") { excludedPrivate++; continue; }
    const key = row.job.noteId && row.job.outcome === "verified" ? `${row.job.accountId}:${row.job.noteId}` : `job:${row.job.id}`;
    if (seen.has(key)) { excludedDuplicate++; continue; } seen.add(key);
    notes.push(noteSummary(row.job, row.draft, row.nickname, byJob.get(row.job.id) ?? [], query.horizon ?? "latest"));
  }
  return { notes, excludedPrivate, excludedDuplicate };
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
export function calibration(notes: InsightNote[], horizon: MetricsHorizon) {
  const exclusions: Record<string, number> = {};
  const grouped = new Map<string, InsightNote[]>();
  for (const n of notes) {
    const p = n.planning;
    const reason = n.visibility !== "public" ? "非公开笔记" : horizon === "latest" ? "最新快照年龄不可比"
      : !n.publishedAt ? "实际发布时间缺失" : !n.metric ? "窗口内未采到" : n.metric.interactions === null ? "互动字段不全"
      : !p || p.score === null || !p.scoreMethod || !p.scoreModel || !p.scoredAt ? "发布前评分依据缺失"
      : p.accountId !== n.accountId ? "评分账号与发布账号不同" : null;
    if (reason) { exclusions[reason] = (exclusions[reason] ?? 0) + 1; continue; }
    const band = p!.score! < 60 ? "0–59" : p!.score! < 80 ? "60–79" : "80–100";
    const key = JSON.stringify([n.accountId, p!.scoreMethod, p!.scoreModel, band]);
    const group = grouped.get(key) ?? []; group.push(n); grouped.set(key, group);
  }
  const groups: CalibrationGroup[] = [...grouped].map(([key, ns]) => {
    const [accountId, scoreMethod, scoreModel, scoreBand] = JSON.parse(key);
    const views = ns.flatMap(n => n.metric!.views === null ? [] : [n.metric!.views]);
    const exposure = ns.flatMap(n => n.metric!.exposure === null ? [] : [n.metric!.exposure]);
    return { accountId, accountName: ns[0]!.accountName, scoreMethod, scoreModel, scoreBand, count: ns.length,
      medianScore: median(ns.map(n => n.planning!.score!))!, medianTraffic: median(ns.flatMap(n => n.planning!.scoreDetail?.traffic === undefined ? [] : [n.planning!.scoreDetail.traffic])),
      medianInteractions: median(ns.map(n => n.metric!.interactions!))!, medianViews: median(views), medianExposure: median(exposure),
      viewsCount: views.length, exposureCount: exposure.length, minAgeMs: Math.min(...ns.map(n => n.metric!.ageMs!)), maxAgeMs: Math.max(...ns.map(n => n.metric!.ageMs!)) };
  }).sort((a, b) => a.accountId - b.accountId || a.scoreBand.localeCompare(b.scoreBand));
  return { horizon, eligibleCount: groups.reduce((s, g) => s + g.count, 0), exclusions, groups,
    message: "仅观察同账号、同评分口径与模型、同采样窗口的表现；样本量和曝光覆盖不足时不调整权重。互动不能代表变现、成本或合规表现。" };
}

export async function accountTrends(db: Db, userId: number, query: InsightsQuery) {
  const filters = [eq(accountSnapshots.userId, userId)];
  if (query.accountId) filters.push(eq(accountSnapshots.accountId, query.accountId));
  if (query.from !== undefined) filters.push(gte(accountSnapshots.capturedAt, new Date(query.from)));
  if (query.to !== undefined) filters.push(lte(accountSnapshots.capturedAt, new Date(query.to)));
  const rows = await db.select({ snapshot: accountSnapshots, nickname: hostedAccounts.nickname }).from(accountSnapshots)
    .innerJoin(hostedAccounts, and(eq(hostedAccounts.id, accountSnapshots.accountId), eq(hostedAccounts.userId, userId)))
    .where(and(...filters)).orderBy(asc(accountSnapshots.capturedAt), asc(accountSnapshots.id));
  const accounts = new Map<number, { accountId: number; nickname: string; points: Array<{ id: number; capturedAt: string; followers: number | null; likesTotal: number | null; notesCount: number | null }> }>();
  for (const { snapshot: s, nickname } of rows) {
    const item = accounts.get(s.accountId!) ?? { accountId: s.accountId!, nickname, points: [] };
    item.points.push({ id: s.id, capturedAt: s.capturedAt.toISOString(), followers: s.followers, likesTotal: s.likesTotal, notesCount: s.notesCount });
    accounts.set(s.accountId!, item);
  }
  return [...accounts.values()];
}

export async function postmortemEvidence(db: Db, userId: number, id: number): Promise<PostmortemEvidence | null> {
  const [row] = await db.select({ job: publishJobs, draft: drafts, nickname: hostedAccounts.nickname }).from(publishJobs)
    .innerJoin(drafts, and(eq(drafts.id, publishJobs.draftId), eq(drafts.userId, userId)))
    .innerJoin(hostedAccounts, and(eq(hostedAccounts.id, publishJobs.accountId), eq(hostedAccounts.userId, userId)))
    .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId))).limit(1);
  if (!row) return null;
  const { job, draft, nickname } = row;
  const rows = await db.select().from(noteMetrics).where(and(eq(noteMetrics.userId, userId), eq(noteMetrics.publishJobId, id))).orderBy(asc(noteMetrics.capturedAt), asc(noteMetrics.id));
  const metrics = rows.filter(m => job.outcome === "verified" && job.noteId && m.noteId === job.noteId).map(m => metricPoint(m, job.publishedAt));
  const gaps = [
    job.status !== "done" ? "发布尚未成功" : "",
    job.outcome !== "verified" ? "笔记尚未核对确认" : "",
    job.visibility !== "public" ? "非公开笔记，不能评估公开传播效果或用于评分校准" : "",
    !job.draftSnapshot ? "历史任务无发布正文快照；展示当前草稿，不能确认是发布原文" : "",
    !job.coverSnapshot ? "发布时封面参数未保存" : "",
    !job.personaSnapshot ? "发布时人设快照缺失" : "",
    !job.planningSnapshot ? "发布前选题评分快照缺失" : "",
    !job.publishedAt ? "平台实际发布时间未采到；不能标记发布后 1 小时/1 天/7 天表现" : "",
    !metrics.length ? "尚无确认笔记的指标快照" : "",
    metrics.some(m => m.views === null) ? "部分或全部快照未采到浏览量" : "",
    metrics.some(m => m.exposure === null) ? "部分或全部快照未采到曝光，不能归因点击率或推荐流量" : "",
    metrics.some(m => m.interactions === null) ? "部分互动字段缺失，不能计算完整互动合计" : "",
    "没有流量来源、投放与受众对照，可能原因不能当成因果结论",
  ].filter(Boolean);
  return { note: noteSummary(job, draft, nickname, metrics, "latest"),
    content: job.draftSnapshot ?? { title: draft.title, content: draft.content, tags: draft.tags, images: draft.images },
    cover: job.coverSnapshot, persona: job.personaSnapshot, metrics, gaps };
}
