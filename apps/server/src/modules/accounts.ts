import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { ACCOUNT_PERSONA_LIMITS } from "@v2media/shared";

import type { Deps } from "../context";
import { drafts, hostedAccounts, jobs, publishJobs } from "../db/schema";

/** 心跳超过 15 分钟没来的账号标记 stale。 */
export const STALE_MS = 15 * 60 * 1000;

export function accountsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  const personaSchema = z.object({
    version: z.number().int().nonnegative(),
    positioning: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.positioning).optional(),
    styleNotes: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.styleNotes).optional(),
    redlines: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.redlines).optional(),
  }).strict().refine(p => p.positioning !== undefined || p.styleNotes !== undefined || p.redlines !== undefined, "请提供人设字段");

  app.patch("/:id", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const p = personaSchema.safeParse(await c.req.json().catch(() => null));
    if (!p.success) return c.json({ error: p.error.issues[0]?.message ?? "人设参数无效" }, 400);
    const userId = c.get("userId");
    const [owned] = await deps.db.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, userId)));
    if (!owned) return c.json({ error: "account not found" }, 404);
    if (owned.archivedAt) return c.json({ error: "账号已归档，请恢复后再修改人设" }, 409);
    const { version, ...fields } = p.data;
    const changed = (fields.positioning !== undefined && fields.positioning !== owned.positioning)
      || (fields.styleNotes !== undefined && fields.styleNotes !== owned.styleNotes)
      || (fields.redlines !== undefined && fields.redlines !== owned.redlines);
    const [updated] = await deps.db.update(hostedAccounts).set({ ...fields, personaVersion: sql`${hostedAccounts.personaVersion} + ${changed ? 1 : 0}` })
      .where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, userId), isNull(hostedAccounts.archivedAt), eq(hostedAccounts.personaVersion, version))).returning();
    return updated ? c.json(updated) : c.json({ error: "账号人设已更新，请读取最新内容后再保存" }, 409);
  });

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const staleBefore = new Date(deps.now().getTime() - STALE_MS);
    const rows = await deps.db
      .select()
      .from(hostedAccounts)
      .where(and(eq(hostedAccounts.userId, userId), c.req.query("includeArchived") === "1" ? undefined : isNull(hostedAccounts.archivedAt)))
      .orderBy(hostedAccounts.id);
    // Freshness is an observation, not a write triggered by reading a list.
    return c.json(rows.map(row => ({ ...row, status: row.status === "online" && row.lastSeenAt && row.lastSeenAt < staleBefore ? "stale" : row.status })));
  });

  app.delete("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const userId = c.get("userId");
    const found = await deps.db.transaction(async tx => {
      await tx.execute(sql`SELECT id FROM hosted_accounts WHERE id = ${id} AND user_id = ${userId} FOR UPDATE`);
      const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, userId)));
      if (!account) return false;
      if (account.archivedAt) return true;
      await tx.update(hostedAccounts).set({ archivedAt: deps.now(), executionRevision: account.executionRevision + 1 }).where(eq(hostedAccounts.id, id));
      // Restore cannot authorize model results that began before this archive.
      // Lock draft before publication, matching draft archive and publish creation.
      const interrupted = await tx.update(drafts).set({ generationRevision: sql`${drafts.generationRevision} + 1`,
        generationState: "failed", generationError: "写作账号已归档，成稿已停止；恢复后可手动重试", updatedAt: deps.now() })
        .where(and(eq(drafts.userId, userId), eq(drafts.accountId, id), inArray(drafts.generationState, ["queued", "writing"]))).returning({ id: drafts.id });
      if (interrupted.length) await tx.update(jobs).set({ status: "canceled", error: "写作账号已归档", finishedAt: deps.now() })
        .where(and(eq(jobs.userId, userId), eq(jobs.type, "draft_generate"), inArray(jobs.status, ["queued", "processing"]),
          sql`${jobs.payload}->>'draftId' IN (${sql.join(interrupted.map(draft => sql`${String(draft.id)}`), sql`, `)})`));
      // Already dispatched site actions and historical attribution must survive.
      await tx.update(publishJobs).set({ status: "canceled", error: "发布账号已归档，未开始的发布已取消", updatedAt: deps.now() })
        .where(and(eq(publishJobs.userId, userId), eq(publishJobs.accountId, id), eq(publishJobs.status, "pending")));
      await tx.update(jobs).set({ status: "canceled", error: "账号已归档", finishedAt: deps.now() })
        .where(and(eq(jobs.userId, userId), eq(jobs.type, "account_snapshot"), eq(jobs.status, "pending"), sql`${jobs.payload}->>'accountId' = ${String(id)}`));
      return true;
    });
    return found ? c.json({ ok: true }) : c.json({ error: "account not found" }, 404);
  });

  app.post("/:id/restore", async c => {
    const id = Number(c.req.param("id"));
    if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: "bad id" }, 400);
    const [account] = await deps.db.update(hostedAccounts).set({ archivedAt: null })
      .where(and(eq(hostedAccounts.id, id), eq(hostedAccounts.userId, c.get("userId")))).returning();
    return account ? c.json(account) : c.json({ error: "account not found" }, 404);
  });

  return app;
}
