import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../context";
import { aiRuns } from "../db/schema";
import { createAiRunHandlers } from "../lib/ai-run-handlers";
import { aiRunView, cancelAiRun, retryAiRun } from "../lib/ai-runs";

export function aiRunsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  const handlers = createAiRunHandlers(deps);
  const positiveId = (value: string) => { const id = Number(value); return Number.isSafeInteger(id) && id > 0 ? id : null; };
  app.get("/runs", async c => {
    const filter = z.object({ kind: z.enum(["analysis", "topic_generate", "topic_score"]).optional(),
      status: z.enum(["queued", "running", "done", "failed", "canceled"]).optional() }).safeParse(c.req.query());
    if (!filter.success) return c.json({ error: "AI 任务筛选参数无效" }, 400);
    const items = await deps.db.select().from(aiRuns).where(and(eq(aiRuns.userId, c.get("userId")),
      filter.data.kind ? eq(aiRuns.kind, filter.data.kind) : undefined, filter.data.status ? eq(aiRuns.status, filter.data.status) : undefined))
      .orderBy(desc(aiRuns.id)).limit(50);
    return c.json({ items: items.map(aiRunView) });
  });
  app.get("/runs/:id", async c => {
    const id = positiveId(c.req.param("id"));
    if (!id) return c.json({ error: "AI 任务 ID 无效" }, 400);
    const [run] = await deps.db.select().from(aiRuns).where(and(eq(aiRuns.id, id), eq(aiRuns.userId, c.get("userId")))).limit(1);
    return run ? c.json(aiRunView(run)) : c.json({ error: "AI 任务不存在" }, 404);
  });
  app.post("/runs/:id/retry", async c => {
    const id = positiveId(c.req.param("id"));
    if (!id) return c.json({ error: "AI 任务 ID 无效" }, 400);
    const text = await c.req.text();
    let body: unknown = {};
    try { if (text.trim()) body = JSON.parse(text); } catch { return c.json({ error: "AI 重试参数无效" }, 400); }
    const parsed = z.object({ operationId: z.string().uuid().optional() }).strict().safeParse(body);
    if (!parsed.success) return c.json({ error: "AI 重试参数无效" }, 400);
    const result = await retryAiRun(deps, handlers, c.get("userId"), id, parsed.data.operationId);
    return result.run ? c.json(aiRunView(result.run), 202) : c.json({ error: result.error }, result.code as 404 | 409);
  });
  app.post("/runs/:id/cancel", async c => {
    const id = positiveId(c.req.param("id"));
    if (!id) return c.json({ error: "AI 任务 ID 无效" }, 400);
    const result = await cancelAiRun(deps, handlers, c.get("userId"), id);
    return result.run ? c.json(aiRunView(result.run)) : c.json({ error: result.error }, result.code as 404 | 409);
  });
  return app;
}
