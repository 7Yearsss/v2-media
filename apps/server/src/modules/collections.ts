import { and, count, desc, eq, getTableColumns, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import { env } from "../env";
import type { Deps } from "../context";
import type { Db } from "../db";
import { analysisPromptBody, analysisPromptComments, type RunNote } from "../lib/analysis-run";
import type { AnalysisAiInput } from "../lib/analysis-ai-run";
import { AiRunConflict, enqueueAiRun, findAiRunOperation } from "../lib/ai-runs";
import { HYPOTHESIS_SYSTEM, REPORT_SYSTEM, VISION_SYSTEM, VIDEO_SYSTEM } from "../lib/analysis-prompts";
import { computeSignals, engagementOf, type SignalNote } from "../lib/analysis-signals";
import { collectedNotes, collectionAnalyses, collections, hostedAccounts } from "../db/schema";
import { ACCOUNT_PERSONA_LIMITS } from "@v2media/shared";
import { resolveAccountPersona } from "../lib/account-persona";
import { isReadOnly } from "../lib/runtime-policy";

/** 一次分析喂给模型的笔记上限（按互动量取 top）。 */
const ANALYZE_LIMIT = 40;
/** 分析 running 超过这么久视为中断（AI 单次最长 ~5min，两步加起来留足余量）。 */
const ANALYZE_STALE_MS = 12 * 60_000;

const nameSchema = z.object({
  name: z.string().trim().min(1, "name required").max(64),
});

/** 采集分组 CRUD：列表带各库笔记数；删库只置空笔记的 collection_id（SET NULL）。 */
export function collectionsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const rows = await deps.db
      .select({
        id: collections.id,
        name: collections.name,
        createdAt: collections.createdAt,
        noteCount: count(collectedNotes.id),
      })
      .from(collections)
      .leftJoin(collectedNotes, eq(collectedNotes.collectionId, collections.id))
      .where(eq(collections.userId, userId))
      .groupBy(collections.id)
      .orderBy(collections.id);
    return c.json({ items: rows });
  });

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    // 同名直接返回已有库（幂等：插件/工作台重复创建不报错）
    const [existing] = await deps.db
      .select()
      .from(collections)
      .where(and(eq(collections.userId, userId), eq(collections.name, parsed.data.name)))
      .limit(1);
    if (existing) return c.json({ ...existing, noteCount: 0 });
    // 并发同名创建：唯一索引兜底，撞了就把对方先插的那条返回
    try {
      const [row] = await deps.db
        .insert(collections)
        .values({ userId, name: parsed.data.name })
        .returning();
      return c.json({ ...row!, noteCount: 0 }, 201);
    } catch {
      const [again] = await deps.db
        .select()
        .from(collections)
        .where(and(eq(collections.userId, userId), eq(collections.name, parsed.data.name)))
        .limit(1);
      if (!again) return c.json({ error: "create failed" }, 500);
      return c.json({ ...again, noteCount: 0 });
    }
  });

  app.patch("/:id", async (c) => {
    const userId = c.get("userId");
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(collections)
      .set({ name: parsed.data.name })
      .where(and(eq(collections.id, Number(c.req.param("id"))), eq(collections.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const [row] = await deps.db
      .delete(collections)
      .where(and(eq(collections.id, Number(c.req.param("id"))), eq(collections.userId, userId)))
      .returning({ id: collections.id });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  /** 校验库归属并取出库行。 */
  const ownCollection = async (c: any) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    if (!Number.isInteger(id)) return null;
    const [col] = await deps.db
      .select()
      .from(collections)
      .where(and(eq(collections.id, id), eq(collections.userId, userId)))
      .limit(1);
    return col ?? null;
  };

  // AI 分析：代码先算信号（差异/钩子/评论分类/不可复制），AI 两步（假设 → 挑错出终稿），报告落库可回看
  app.post("/:id/analyze", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    const userId = c.get("userId");
    const parsed = z.object({ operationId: z.string().uuid().optional(), accountId: z.number().int().positive().optional(),
      positioning: z.string().trim().max(ACCOUNT_PERSONA_LIMITS.positioning).optional(), withVideo: z.boolean().optional() })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const body = parsed.data;
    const request = { collectionId: col.id, ...body };
    try {
      const replay = await deps.db.transaction(tx => findAiRunOperation(tx as unknown as Db, userId, body.operationId, "analysis", request));
      if (replay) {
        const [saved] = await deps.db.select().from(collectionAnalyses).where(and(eq(collectionAnalyses.id, replay.targetId), eq(collectionAnalyses.userId, userId)));
        return saved ? c.json(saved, saved.status === "running" ? 202 : 200) : c.json({ error: "原分析已不存在，请创建新分析" }, 409);
      }
    } catch (error) { if (error instanceof AiRunConflict) return c.json({ error: error.message }, 409); throw error; }
    const persona = await resolveAccountPersona(deps.db, userId, body.accountId, body.positioning);
    if ("error" in persona) return c.json({ error: persona.error }, persona.code ?? 404);
    const positioning = persona.snapshot?.positioning ?? "";
    const personaData = { persona: persona.snapshot, ...(positioning ? { positioning } : {}) };
    const notes = await deps.db
      .select({
        id: collectedNotes.id,
        noteId: collectedNotes.noteId,
        type: collectedNotes.type,
        authorName: collectedNotes.authorName,
        title: collectedNotes.title,
        cover: collectedNotes.cover,
        videoUrl: collectedNotes.videoUrl,
        rawJson: collectedNotes.rawJson,
        likes: collectedNotes.likes,
        collects: collectedNotes.collects,
        comments: collectedNotes.comments,
        shares: collectedNotes.shares,
        tags: collectedNotes.tags,
        content: collectedNotes.content,
        hasDetail: collectedNotes.hasDetail,
        publishedAt: collectedNotes.publishedAt,
        ipLocation: collectedNotes.ipLocation,
        sourceKeyword: collectedNotes.sourceKeyword,
        commentsData: collectedNotes.commentsData,
      })
      .from(collectedNotes)
      .where(and(eq(collectedNotes.collectionId, col.id), eq(collectedNotes.userId, userId)))
      .orderBy(
        desc(sql`${collectedNotes.likes} + ${collectedNotes.collects} + ${collectedNotes.comments} + ${collectedNotes.shares}`),
      )
      // 拉宽候选池：高日均互动的新帖可能总量还没进 top40，不能漏掉
      .limit(ANALYZE_LIMIT * 3);
    if (!notes.length) return c.json({ error: "库里还没有笔记" }, 400);

    const engagement = engagementOf;
    const dayAge = (n: (typeof notes)[number]) =>
      n.publishedAt
        ? Math.max(1, Math.ceil((deps.now().getTime() - n.publishedAt.getTime()) / 86_400_000))
        : null;
    // 笔记 #编号 = 在候选池里的互动排名（1 起）；AI 只引用编号，服务端映射回笔记
    const refOf = new Map(notes.map((n, i) => [n.id, i + 1]));
    // 分析样本 = 总互动 top40 ∪ 日均互动 top10（后进来的新爆款）
    const analysisNotes = new Map<number, (typeof notes)[number]>();
    for (const n of notes.slice(0, ANALYZE_LIMIT)) analysisNotes.set(n.id, n);
    const byDailyRate = notes
      .filter((n) => dayAge(n) != null)
      .sort((a, b) => engagement(b) / dayAge(b)! - engagement(a) / dayAge(a)!)
      .slice(0, 10);
    for (const n of byDailyRate) analysisNotes.set(n.id, n);
    const analysisList = [...analysisNotes.values()];

    // 确定性统计：爆款榜 + 标签热度 + 总量/均值（前端画图用，不走 AI）
    const statNotes = notes.slice(0, ANALYZE_LIMIT);
    const tagFreq = new Map<string, number>();
    for (const n of statNotes) for (const t of n.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    const signals = computeSignals(
      notes.map<SignalNote>((n) => ({ ...n, ref: refOf.get(n.id)!, commentsData: n.commentsData })),
      deps.now(),
    );
    const stats = {
      totalNotes: statNotes.length,
      totalLikes: statNotes.reduce((s, n) => s + n.likes, 0),
      totalCollects: statNotes.reduce((s, n) => s + n.collects, 0),
      totalComments: statNotes.reduce((s, n) => s + n.comments, 0),
      totalShares: statNotes.reduce((s, n) => s + n.shares, 0),
      avgEngagement: Math.round(statNotes.reduce((s, n) => s + engagement(n), 0) / statNotes.length),
      topNotes: statNotes.slice(0, 8).map((n) => ({
        noteId: n.noteId,
        title: n.title,
        likes: n.likes,
        collects: n.collects,
        comments: n.comments,
        shares: n.shares,
        engagement: engagement(n),
      })),
      topTags: [...tagFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([tag, cnt]) => ({ tag, count: cnt })),
      // 数据覆盖：藏/评/转/正文只有详情页才采得到 —— 按 hasDetail 溯源而不是按数值猜
      coverage: {
        withDetail: statNotes.filter((n) => n.hasDetail).length,
        total: statNotes.length,
      },
      signals,
    };

    const runNotes: RunNote[] = notes.map((n) => {
      const v = (n.rawJson as { video?: { size?: number; durationMs?: number } } | null)?.video;
      return {
        id: n.id, ref: refOf.get(n.id)!, noteId: n.noteId, type: n.type, title: n.title, cover: n.cover,
        videoUrl: n.videoUrl, videoSize: v?.size ?? null, videoDurationMs: v?.durationMs ?? null,
        likes: n.likes, collects: n.collects, comments: n.comments, shares: n.shares, tags: n.tags,
        content: analysisPromptBody(n.content), contentForPrompt: true, hasDetail: n.hasDetail,
        publishedAt: n.publishedAt, sourceKeyword: n.sourceKeyword, commentsData: analysisPromptComments(n.commentsData),
      };
    });
    const sampleSet = new Set(analysisList.map((n) => n.id));
    try {
      const result = await deps.db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const replay = await findAiRunOperation(tx, userId, body.operationId, "analysis", request);
        if (replay) {
          const [saved] = await tx.select().from(collectionAnalyses).where(and(eq(collectionAnalyses.id, replay.targetId), eq(collectionAnalyses.userId, userId)));
          return saved ? { row: saved } : { error: "原分析已不存在，请创建新分析", code: 409 as const };
        }
        await tx.execute(sql`SELECT id FROM collections WHERE id=${col.id} AND user_id=${userId} FOR SHARE`);
        const [currentCollection] = await tx.select().from(collections).where(and(eq(collections.id, col.id), eq(collections.userId, userId)));
        if (!currentCollection) return { error: "采集库已删除", code: 404 as const };
        let executionRevision: number | null = null;
        if (body.accountId) {
          await tx.execute(sql`SELECT id FROM hosted_accounts WHERE id=${body.accountId} AND user_id=${userId} FOR SHARE`);
          const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, body.accountId), eq(hostedAccounts.userId, userId)));
          if (!account || account.archivedAt || account.personaVersion !== persona.snapshot?.version) return { error: "目标账号已变化，请重新确认", code: 409 as const };
          executionRevision = account.executionRevision;
        }
        const [row] = await tx.insert(collectionAnalyses).values({ userId, collectionId: col.id, noteCount: notes.length, status: "running", data: { stats, insight: null, ...personaData }, createdAt: deps.now() }).returning();
        const model = env.aiAnalysisModel || env.aiModel;
        const input: AnalysisAiInput = { collectionId: col.id, accountId: body.accountId ?? null, executionRevision, stats, persona: persona.snapshot, positioning,
          input: { colName: col.name, positioning, persona: persona.snapshot, pool: runNotes, sample: runNotes.filter(n => sampleSet.has(n.id)), signals, now: deps.now(), withVideo: body.withVideo === true,
            models: { analysis: model, vision: env.aiVisionModel || model }, prompts: { hypothesis: HYPOTHESIS_SYSTEM, report: REPORT_SYSTEM, vision: VISION_SYSTEM, video: VIDEO_SYSTEM } } };
        const run = await enqueueAiRun(tx, { userId, kind: "analysis", targetType: "analysis", targetId: row!.id, operationId: body.operationId, request, input, model, promptVersion: "analysis-evidence-v1", now: deps.now() });
        const [linked] = await tx.update(collectionAnalyses).set({ aiRunId: run.id }).where(eq(collectionAnalyses.id, row!.id)).returning();
        return { row: linked! };
      });
      return "error" in result ? c.json({ error: result.error }, result.code) : c.json(result.row, result.row.status === "running" ? 202 : 200);
    } catch (error) { if (error instanceof AiRunConflict) return c.json({ error: error.message }, 409); throw error; }
  });

  /** running 太久（进程重启/AI 挂死）的行标记失败，避免页面永远转圈。 */
  const reapStale = (colId: number) =>
    isReadOnly(deps) ? Promise.resolve() :
    deps.db
      .update(collectionAnalyses)
      .set({ status: "failed", error: "分析中断（服务重启或超时），请重试" })
      .where(
        and(
          eq(collectionAnalyses.collectionId, colId),
          eq(collectionAnalyses.status, "running"),
          isNull(collectionAnalyses.aiRunId),
          // 用库的时钟比较：created_at 是无时区 timestamp，传 JS Date 会按本机时区序列化而错位
          sql`${collectionAnalyses.createdAt} < now() - make_interval(secs => ${ANALYZE_STALE_MS / 1000})`,
        ),
      );

  app.get("/:id/analyses", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    await reapStale(col.id);
    const rows = await deps.db
      .select({
        id: collectionAnalyses.id,
        collectionId: collectionAnalyses.collectionId,
        noteCount: collectionAnalyses.noteCount,
        status: collectionAnalyses.status,
        error: collectionAnalyses.error,
        createdAt: collectionAnalyses.createdAt,
        expired: sql<boolean>`${collectionAnalyses.aiRunId} IS NULL AND ${collectionAnalyses.status}='running' AND ${collectionAnalyses.createdAt} < now() - make_interval(secs => ${ANALYZE_STALE_MS / 1000})`,
      })
      .from(collectionAnalyses)
      .where(eq(collectionAnalyses.collectionId, col.id))
      .orderBy(desc(collectionAnalyses.id));
    return c.json({ items: rows.map(({ expired, ...row }) => expired ? { ...row, status: "failed", error: "分析中断（服务重启或超时），请重试" } : row) });
  });

  app.get("/:id/analyses/:aid", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    const aid = Number(c.req.param("aid"));
    await reapStale(col.id);
    const [row] = await deps.db
      .select({ ...getTableColumns(collectionAnalyses), expired: sql<boolean>`${collectionAnalyses.aiRunId} IS NULL AND ${collectionAnalyses.status}='running' AND ${collectionAnalyses.createdAt} < now() - make_interval(secs => ${ANALYZE_STALE_MS / 1000})` })
      .from(collectionAnalyses)
      .where(
        and(
          eq(collectionAnalyses.id, aid),
          eq(collectionAnalyses.collectionId, col.id),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    const { expired, ...view } = row;
    return c.json(expired ? { ...view, status: "failed", error: "分析中断（服务重启或超时），请重试" } : view);
  });

  return app;
}
