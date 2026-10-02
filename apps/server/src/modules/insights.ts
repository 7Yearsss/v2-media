import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { METRIC_FIELDS, type InsightsOverview, type InsightsQuery } from "@v2media/shared";
import type { Deps } from "../context";
import { hostedAccounts, postmortemReports } from "../db/schema";
import { accountTrends, calibration, loadInsights, postmortemEvidence } from "../lib/insights-data";
import { reportView } from "../lib/postmortem-jobs";
import { desc } from "drizzle-orm";

const querySchema = z.object({ accountId: z.coerce.number().int().positive().optional(),
  from: z.coerce.number().int().min(0).max(8.64e15).optional(), to: z.coerce.number().int().min(0).max(8.64e15).optional(),
  horizon: z.enum(["latest", "1h", "24h", "7d"]).default("latest"), includePrivate: z.literal("1").optional(),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0) }).refine(q => q.from === undefined || q.to === undefined || q.from <= q.to, "日期范围无效");

export function insightsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.use("*", async (c, next) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "洞察筛选无效" }, 400);
    if (parsed.data.accountId) {
      const [account] = await deps.db.select({ id: hostedAccounts.id }).from(hostedAccounts).where(and(eq(hostedAccounts.id, parsed.data.accountId), eq(hostedAccounts.userId, c.get("userId"))));
      if (!account) return c.json({ error: "account not found" }, 404);
    }
    await next();
  });
  const query = (raw: Record<string, string>): InsightsQuery => querySchema.parse(raw);
  app.get("/overview", async c => {
    const q = query(c.req.query()), userId = c.get("userId");
    const [data, accounts] = await Promise.all([loadInsights(deps.db, userId, q), accountTrends(deps.db, userId, q)]);
    const totals = Object.fromEntries(METRIC_FIELDS.map(k => [k, null])) as InsightsOverview["totals"];
    const coverage = Object.fromEntries(METRIC_FIELDS.map(k => [k, 0])) as InsightsOverview["coverage"];
    for (const n of data.notes) for (const k of METRIC_FIELDS) if (n.metric?.[k] !== null && n.metric?.[k] !== undefined) {
      totals[k] = (totals[k] ?? 0) + n.metric[k]!; coverage[k]++;
    }
    return c.json({ notesCount: data.notes.length, sampledCount: data.notes.filter(n => n.metric).length,
      missingMetrics: data.notes.filter(n => !n.metric).length, excludedPrivate: data.excludedPrivate,
      excludedDuplicate: data.excludedDuplicate, totals, coverage, accounts, calibration: calibration(data.notes, q.horizon ?? "latest") } satisfies InsightsOverview);
  });
  app.get("/notes", async c => {
    const q = query(c.req.query()); const { notes } = await loadInsights(deps.db, c.get("userId"), q);
    // Account groups keep different audience sizes separate. Missing stays at each group's bottom.
    notes.sort((a, b) => a.accountId - b.accountId || (b.metric?.interactions ?? -1) - (a.metric?.interactions ?? -1) || b.publishJobId - a.publishJobId);
    const offset = q.offset ?? 0;
    return c.json({ items: notes.slice(offset, offset + 30), total: notes.length, nextOffset: offset + 30 < notes.length ? offset + 30 : null });
  });
  app.get("/notes/:id", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const evidence = await postmortemEvidence(deps.db, c.get("userId"), id);
    if (!evidence) return c.json({ error: "not found" }, 404);
    const reports = await deps.db.select().from(postmortemReports).where(and(eq(postmortemReports.userId, c.get("userId")), eq(postmortemReports.publishJobId, id))).orderBy(desc(postmortemReports.id)).limit(20);
    return c.json({ note: evidence.note, evidence, reports: reports.map(reportView) });
  });
  return app;
}
