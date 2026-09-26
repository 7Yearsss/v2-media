import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, collectionAnalyses, collections } from "../db/schema";

/** 一次分析喂给模型的笔记上限（按互动量取 top）。 */
const ANALYZE_LIMIT = 40;

const ANALYSIS_SYSTEM =
  "你是资深小红书运营分析师。输入是一个采集库里的笔记列表（标题/互动数据/标签/正文节选）。" +
  "要求：每条结论必须引用库里的具体笔记标题或数字，禁止空话套话；" +
  "如果收藏/评论/分享字段都是 0，要在 summary 里点明该库只有曝光数据、无法判断转化。" +
  "只输出一个 JSON 对象（不要 markdown 围栏、不要多余文字），结构：" +
  '{"summary":"一句话结论（必须含具体数据）","topNotes":[{"title":"笔记标题","why":"它火的原因（引用其具体数据/标题特征）"}],' +
  '"patterns":["爆款共性规律 2-4 条，每条点名对应哪几篇"],"opportunities":["还没吃透的机会点 1-3 条"],' +
  '"actions":["可执行建议 3 条，各给出一个可直接用的完整标题"]}';

/** 从模型输出里抠出 JSON 洞察；失败返回 null（原文进 report 兜底）。 */
function parseInsight(text: string) {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).filter(Boolean) : []);
    const insight = {
      summary: typeof j.summary === "string" ? j.summary : "",
      topNotes: Array.isArray(j.topNotes)
        ? j.topNotes
            .map((n: any) => ({ title: String(n?.title ?? ""), why: String(n?.why ?? "") }))
            .filter((n: { title: string }) => n.title)
        : [],
      patterns: arr(j.patterns),
      opportunities: arr(j.opportunities),
      actions: arr(j.actions),
    };
    // 模型返回了无关 JSON（如 {"error":...}）时视为解析失败，走原文兜底
    const usable =
      insight.summary ||
      insight.topNotes.length ||
      insight.patterns.length ||
      insight.opportunities.length ||
      insight.actions.length;
    return usable ? insight : null;
  } catch {
    return null;
  }
}

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

  // AI 分析：确定性统计（服务端算）+ 结构化洞察（AI 出 JSON），报告落库可回看
  app.post("/:id/analyze", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    const userId = c.get("userId");
    const notes = await deps.db
      .select({
        noteId: collectedNotes.noteId,
        title: collectedNotes.title,
        likes: collectedNotes.likes,
        collects: collectedNotes.collects,
        comments: collectedNotes.comments,
        shares: collectedNotes.shares,
        tags: collectedNotes.tags,
        content: collectedNotes.content,
        hasDetail: collectedNotes.hasDetail,
      })
      .from(collectedNotes)
      .where(eq(collectedNotes.collectionId, col.id))
      .orderBy(
        desc(sql`${collectedNotes.likes} + ${collectedNotes.collects} + ${collectedNotes.comments} + ${collectedNotes.shares}`),
      )
      .limit(ANALYZE_LIMIT);
    if (!notes.length) return c.json({ error: "库里还没有笔记" }, 400);

    // 确定性统计：爆款榜 + 标签热度 + 总量/均值（前端画图用，不走 AI）
    const engagement = (n: (typeof notes)[number]) => n.likes + n.collects + n.comments + n.shares;
    const tagFreq = new Map<string, number>();
    for (const n of notes) for (const t of n.tags) tagFreq.set(t, (tagFreq.get(t) ?? 0) + 1);
    const stats = {
      totalNotes: notes.length,
      totalLikes: notes.reduce((s, n) => s + n.likes, 0),
      totalCollects: notes.reduce((s, n) => s + n.collects, 0),
      totalComments: notes.reduce((s, n) => s + n.comments, 0),
      totalShares: notes.reduce((s, n) => s + n.shares, 0),
      avgEngagement: Math.round(notes.reduce((s, n) => s + engagement(n), 0) / notes.length),
      topNotes: notes.slice(0, 8).map((n) => ({
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
        withDetail: notes.filter((n) => n.hasDetail).length,
        total: notes.length,
      },
    };

    const payload = notes
      .map((n) => ({
        标题: n.title,
        赞: n.likes,
        收藏: n.collects,
        评论: n.comments,
        分享: n.shares,
        标签: n.tags.slice(0, 8),
        正文节选: n.content.slice(0, 300),
      }))
      .map((n) => JSON.stringify(n))
      .join("\n");
    let report: string;
    try {
      report = await deps.ai.complete(ANALYSIS_SYSTEM, `采集库「${col.name}」共 ${notes.length} 篇：\n${payload}`);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
    }
    const [row] = await deps.db
      .insert(collectionAnalyses)
      .values({
        userId,
        collectionId: col.id,
        noteCount: notes.length,
        data: { stats, insight: parseInsight(report) },
        report,
      })
      .returning();
    return c.json(row, 201);
  });

  app.get("/:id/analyses", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    const rows = await deps.db
      .select({
        id: collectionAnalyses.id,
        collectionId: collectionAnalyses.collectionId,
        noteCount: collectionAnalyses.noteCount,
        createdAt: collectionAnalyses.createdAt,
      })
      .from(collectionAnalyses)
      .where(eq(collectionAnalyses.collectionId, col.id))
      .orderBy(desc(collectionAnalyses.id));
    return c.json({ items: rows });
  });

  app.get("/:id/analyses/:aid", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    const aid = Number(c.req.param("aid"));
    const [row] = await deps.db
      .select()
      .from(collectionAnalyses)
      .where(
        and(
          eq(collectionAnalyses.id, aid),
          eq(collectionAnalyses.collectionId, col.id),
        ),
      )
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  return app;
}
