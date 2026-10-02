import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../context";
import type { Db } from "../db";
import { drafts } from "../db/schema";
import { coverSpecSchema } from "../lib/cover-spec";
import { CoverInputError, queueCover } from "../lib/cover-jobs";
import { draftWithUploads } from "../lib/draft-media";
import { retryDraftGeneration } from "../lib/draft-jobs";
import { publicBase } from "../lib/media-store";

export function draftGenerationModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.post("/:id/cover", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const parsed = z.object({ spec: coverSpecSchema, revision: z.number().int().nonnegative() }).safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "封面参数无效" }, 400);
    const userId = c.get("userId");
    const result = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM drafts WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
      const [draft] = await tx.select().from(drafts).where(and(eq(drafts.id, id), eq(drafts.userId, userId)));
      if (!draft) return { error: "草稿不存在", code: 404 as const };
      if (draft.archivedAt) return { error: "草稿已归档，请恢复后再生成封面", code: 409 as const };
      if (!deps.r2) return { error: "未配置 R2 图片存储", code: 503 as const };
      if (draft.coverRevision !== parsed.data.revision) return { error: "封面参数已更新，请重新读取后再生成", code: 409 as const };
      if (["queued", "writing"].includes(draft.generationState)) return { error: "请等待 AI 文字成稿完成后再编辑封面", code: 409 as const };
      try { return await queueCover(tx as unknown as Db, deps, draft, parsed.data.spec, publicBase(c.req)); }
      catch (e) { if (e instanceof CoverInputError) return { error: e.message, code: 400 as const }; throw e; }
    });
    if ("error" in result) return c.json({ error: result.error }, result.code!);
    return c.json({ ...result, draft: await draftWithUploads(deps.db, result.draft) }, 202);
  });
  app.post("/:id/generate/retry", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const result = await retryDraftGeneration(deps, c.get("userId"), id, publicBase(c.req));
    if ("error" in result) return c.json({ error: result.error }, result.code!);
    return c.json({ draft: await draftWithUploads(deps.db, result.draft), jobId: result.jobId }, 202);
  });
  return app;
}
