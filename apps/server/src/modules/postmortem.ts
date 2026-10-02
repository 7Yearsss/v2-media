import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../context";
import type { Db } from "../db";
import { jobs, postmortemReports, publishJobs } from "../db/schema";
import { postmortemEvidence } from "../lib/insights-data";
import { POSTMORTEM_PROMPT_VERSION, postmortemModel, reportView } from "../lib/postmortem-jobs";

export function postmortemModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.post("/postmortem", async c => {
    const parsed = z.object({ publishJobId: z.number().int().positive(), refresh: z.boolean().default(false) }).strict().safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const { publishJobId, refresh } = parsed.data, userId = c.get("userId");
    const result = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM publish_jobs WHERE id = ${publishJobId} AND user_id = ${userId} FOR UPDATE`);
      const [pj] = await tx.select().from(publishJobs).where(and(eq(publishJobs.id, publishJobId), eq(publishJobs.userId, userId)));
      if (!pj) return { error: "not found", code: 404 as const };
      if (pj.status !== "done") return { error: "请在发布成功后复盘", code: 400 as const };
      const [prior] = await tx.select().from(postmortemReports).where(and(eq(postmortemReports.userId, userId), eq(postmortemReports.publishJobId, publishJobId))).orderBy(desc(postmortemReports.id)).limit(1);
      if (prior && (["queued", "running"].includes(prior.status) || (!refresh && prior.status === "done")))
        return { report: reportView(prior), code: prior.status === "done" ? 200 as const : 202 as const };
      const evidence = await postmortemEvidence(tx as unknown as Db, userId, publishJobId);
      if (!evidence) return { error: "not found", code: 404 as const };
      const [report] = await tx.insert(postmortemReports).values({ userId, publishJobId, model: postmortemModel(), promptVersion: POSTMORTEM_PROMPT_VERSION, evidence }).returning();
      await tx.insert(jobs).values({ userId, type: "postmortem", status: "queued", payload: { reportId: report!.id } });
      return { report: reportView(report!), code: 202 as const };
    });
    return "error" in result ? c.json({ error: result.error }, result.code) : c.json(result.report, result.code);
  });
  return app;
}
