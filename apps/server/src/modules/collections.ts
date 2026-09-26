import { and, count, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, collectionAnalyses, collections } from "../db/schema";

/** 一次分析喂给模型的笔记上限（按互动量取 top）。 */
const ANALYZE_LIMIT = 40;

const ANALYSIS_SYSTEM =
  "你是资深小红书运营分析师。输入是一个采集库里的笔记列表（标题/互动数据/标签/正文节选）。请输出 markdown 报告：" +
  "## 爆款 TOP（按赞藏评总量列前 5，附标题和关键数据）；" +
  "## 共性分析（这些火的笔记在选题/标题写法/内容结构上的规律）；" +
  "## 还没被吃透的机会点（库内互动低但选题相似、或库里没覆盖的相邻话题）；" +
  "## 可执行的 3 条行动建议（具体到选题和标题写法）。只输出报告正文。";

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

  // AI 分析：取该库互动量 top 的笔记喂给模型，报告落库可回看
  app.post("/:id/analyze", async (c) => {
    const col = await ownCollection(c);
    if (!col) return c.json({ error: "not found" }, 404);
    const userId = c.get("userId");
    const notes = await deps.db
      .select({
        title: collectedNotes.title,
        likes: collectedNotes.likes,
        collects: collectedNotes.collects,
        comments: collectedNotes.comments,
        shares: collectedNotes.shares,
        tags: collectedNotes.tags,
        content: collectedNotes.content,
      })
      .from(collectedNotes)
      .where(eq(collectedNotes.collectionId, col.id))
      .orderBy(
        desc(sql`${collectedNotes.likes} + ${collectedNotes.collects} + ${collectedNotes.comments} + ${collectedNotes.shares}`),
      )
      .limit(ANALYZE_LIMIT);
    if (!notes.length) return c.json({ error: "库里还没有笔记" }, 400);
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
      .values({ userId, collectionId: col.id, noteCount: notes.length, report })
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
