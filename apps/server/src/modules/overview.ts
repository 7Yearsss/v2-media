import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Deps } from "../context";
import { collectedNotes, drafts, hostedAccounts, publishJobs } from "../db/schema";

export function overviewModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const count = async (table: any) =>
      (await deps.db
        .select({ n: sql<number>`count(*)::int` })
        .from(table)
        .where(eq(table.userId, userId)))[0]!.n;
    const [accounts, notes, draftCount, jobs] = await Promise.all([
      count(hostedAccounts),
      count(collectedNotes),
      count(drafts),
      count(publishJobs),
    ]);

    const jobRows = await deps.db
      .select({ status: publishJobs.status, n: sql<number>`count(*)::int` })
      .from(publishJobs)
      .where(eq(publishJobs.userId, userId))
      .groupBy(publishJobs.status);
    const done = jobRows.find((r) => r.status === "done")?.n ?? 0;
    const finished = jobRows
      .filter((r) => r.status === "done" || r.status === "failed")
      .reduce((s, r) => s + r.n, 0);
    const publishSuccessRate = finished > 0 ? (done / finished) * 100 : null;

    // 近 7 天按来源的采集趋势
    const since = new Date(deps.now().getTime() - 6 * 86400 * 1000);
    const trendRows = await deps.db.execute(sql`
      SELECT to_char(saved_at::date, 'MM-DD') AS label, source, count(*)::int AS n
      FROM collected_notes
      WHERE user_id = ${userId} AND saved_at >= ${since.toISOString().slice(0, 10)}
      GROUP BY 1, 2 ORDER BY 1
    `);
    const rows = (trendRows as any).rows ?? trendRows;
    const byDay = new Map<string, Record<string, number>>();
    for (const r of rows as { label: string; source: string; n: number }[]) {
      const bucket = byDay.get(r.label) ?? {};
      bucket[r.source] = r.n;
      byDay.set(r.label, bucket);
    }
    // 补齐缺失日期，保证连续 7 天
    const trend: { label: string; sources: Record<string, number> }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(deps.now().getTime() - i * 86400 * 1000);
      const label = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      trend.push({ label, sources: byDay.get(label) ?? {} });
    }

    return c.json({
      accounts,
      notes,
      drafts: draftCount,
      publishJobs: jobs,
      publishSuccessRate,
      trend,
    });
  });

  return app;
}
