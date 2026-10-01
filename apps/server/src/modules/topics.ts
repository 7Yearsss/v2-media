import { and, desc, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { generateDraft } from "../lib/draft-gen";
import {
  collectedNotes,
  collections,
  drafts,
  hostedAccounts,
  topics,
} from "../db/schema";

const TOPIC_STATUSES = ["idea", "planned", "drafted", "published", "archived"] as const;

const createSchema = z.object({
  title: z.string().trim().min(1, "title required").max(512),
  angle: z.string().max(4000).default(""),
  collectionId: z.number().int().optional(),
  sourceNoteId: z.number().int().optional(),
  accountId: z.number().int().optional(),
  plannedAt: z.number().int().optional(),
});

const updateSchema = z.object({
  title: z.string().trim().min(1).max(512).optional(),
  angle: z.string().max(4000).optional(),
  status: z.enum(TOPIC_STATUSES).optional(),
  accountId: z.number().int().nullable().optional(),
  plannedAt: z.number().int().nullable().optional(),
});

/** 列表行带展示用关联名（库名/账号昵称/来源笔记标题）。 */
const listSelect = {
  topic: topics,
  collectionName: collections.name,
  accountNickname: hostedAccounts.nickname,
  sourceNoteTitle: collectedNotes.title,
};

export function topicsModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  const owned = async (userId: number, id: number) => {
    const [row] = await deps.db
      .select()
      .from(topics)
      .where(and(eq(topics.id, id), eq(topics.userId, userId)))
      .limit(1);
    return row ?? null;
  };

  /** 校验可空外键归属（collection/sourceNote/account 都必须是本人的）。 */
  const checkRefs = async (
    userId: number,
    refs: { collectionId?: number | null; sourceNoteId?: number | null; accountId?: number | null },
  ) => {
    if (refs.collectionId) {
      const [r] = await deps.db
        .select({ id: collections.id })
        .from(collections)
        .where(and(eq(collections.id, refs.collectionId), eq(collections.userId, userId)))
        .limit(1);
      if (!r) return "collection not found";
    }
    if (refs.sourceNoteId) {
      const [r] = await deps.db
        .select({ id: collectedNotes.id })
        .from(collectedNotes)
        .where(and(eq(collectedNotes.id, refs.sourceNoteId), eq(collectedNotes.userId, userId)))
        .limit(1);
      if (!r) return "source note not found";
    }
    if (refs.accountId) {
      const [r] = await deps.db
        .select({ id: hostedAccounts.id })
        .from(hostedAccounts)
        .where(and(eq(hostedAccounts.id, refs.accountId), eq(hostedAccounts.userId, userId)))
        .limit(1);
      if (!r) return "account not found";
    }
    return null;
  };

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const status = c.req.query("status");
    const conds = [eq(topics.userId, userId)];
    if (status && (TOPIC_STATUSES as readonly string[]).includes(status)) {
      conds.push(eq(topics.status, status));
    }
    const rows = await deps.db
      .select(listSelect)
      .from(topics)
      .leftJoin(collections, eq(topics.collectionId, collections.id))
      .leftJoin(hostedAccounts, eq(topics.accountId, hostedAccounts.id))
      .leftJoin(collectedNotes, eq(topics.sourceNoteId, collectedNotes.id))
      .where(and(...conds))
      .orderBy(desc(topics.updatedAt));
    return c.json({
      items: rows.map((r) => ({
        ...r.topic,
        collectionName: r.collectionName ?? undefined,
        accountNickname: r.accountNickname ?? undefined,
        sourceNoteTitle: r.sourceNoteTitle ?? undefined,
      })),
    });
  });

  app.post("/", async (c) => {
    const userId = c.get("userId");
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    const refErr = await checkRefs(userId, p);
    if (refErr) return c.json({ error: refErr }, 404);
    const [row] = await deps.db
      .insert(topics)
      .values({
        userId,
        title: p.title,
        angle: p.angle,
        sourceType: p.sourceNoteId ? "note" : p.collectionId ? "collection" : "manual",
        collectionId: p.collectionId,
        sourceNoteId: p.sourceNoteId,
        accountId: p.accountId,
        plannedAt: p.plannedAt ? new Date(p.plannedAt) : null,
        status: p.plannedAt ? "planned" : "idea",
      })
      .returning();
    return c.json(row, 201);
  });

  app.patch("/:id", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const parsed = updateSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    if (p.accountId) {
      const refErr = await checkRefs(userId, { accountId: p.accountId });
      if (refErr) return c.json({ error: refErr }, 404);
    }
    // 状态约束：drafted/published 只能由系统流转（to-draft / 发布回填），手动归档除外
    if (p.status === "drafted" || p.status === "published") {
      const t = await owned(userId, id);
      if (!t) return c.json({ error: "not found" }, 404);
      if (t.status !== p.status) return c.json({ error: "该状态由系统流转，不能手动设置" }, 400);
    }
    const patch: Record<string, unknown> = { updatedAt: deps.now() };
    if (p.title !== undefined) patch.title = p.title;
    if (p.angle !== undefined) patch.angle = p.angle;
    if (p.status !== undefined) patch.status = p.status;
    if (p.accountId !== undefined) patch.accountId = p.accountId;
    if (p.plannedAt !== undefined) {
      patch.plannedAt = p.plannedAt ? new Date(p.plannedAt) : null;
      // 给了排期但状态还是 idea → 自动进 planned；清掉排期的 planned → 回 idea
      if (p.plannedAt && p.status === undefined) patch.status = "planned";
      if (!p.plannedAt && p.status === undefined) {
        const t = await owned(userId, id);
        if (t?.status === "planned") patch.status = "idea";
      }
    }
    const [row] = await deps.db
      .update(topics)
      .set(patch)
      .where(and(eq(topics.id, id), eq(topics.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    const userId = c.get("userId");
    const [row] = await deps.db
      .delete(topics)
      .where(and(eq(topics.id, Number(c.req.param("id"))), eq(topics.userId, userId)))
      .returning({ id: topics.id });
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json({ ok: true });
  });

  /** 选题 → 草稿：深拷贝标题+角度进草稿工坊，选题进 drafted。 */
  app.post("/:id/to-draft", async (c) => {
    const userId = c.get("userId");
    const topic = await owned(userId, Number(c.req.param("id")));
    if (!topic) return c.json({ error: "not found" }, 404);
    if (topic.draftId) {
      const [d] = await deps.db
        .select()
        .from(drafts)
        .where(and(eq(drafts.id, topic.draftId), eq(drafts.userId, userId)))
        .limit(1);
      if (d) return c.json({ draft: d, topic });
    }
    const body = (await c.req.json().catch(() => null)) as { ai?: unknown; positioning?: unknown } | null;
    // AI 成稿：借来源爆款的结构写一篇新的；不拷贝对方的图（搬运会被判原创度），图由用户自己补
    if (body?.ai === true) {
      let note: { title: string; content: string; tags: string[] } | undefined;
      if (topic.sourceNoteId) {
        const [n] = await deps.db
          .select({ title: collectedNotes.title, content: collectedNotes.content, tags: collectedNotes.tags })
          .from(collectedNotes)
          .where(and(eq(collectedNotes.id, topic.sourceNoteId), eq(collectedNotes.userId, userId)))
          .limit(1);
        note = n;
      }
      const [hook = "", ...rest] = (topic.angle || "").split("\n");
      let gen;
      try {
        gen = await generateDraft(deps, {
          title: topic.title,
          hook,
          angle: rest.join("\n"),
          positioning: typeof body.positioning === "string" ? body.positioning.trim().slice(0, 200) : "",
          note,
        });
      } catch (e) {
        return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
      }
      const [aiDraft] = await deps.db
        .insert(drafts)
        .values({ userId, collectedNoteId: topic.sourceNoteId, title: gen.title, content: gen.content, tags: gen.tags, images: [] })
        .returning();
      if (!aiDraft) return c.json({ error: "draft create failed" }, 500);
      const [t2] = await deps.db
        .update(topics)
        .set({ status: "drafted", draftId: aiDraft.id, updatedAt: deps.now() })
        .where(eq(topics.id, topic.id))
        .returning();
      return c.json({ draft: aiDraft, topic: t2, coverText: gen.cover, warnings: gen.warnings }, 201);
    }
    // 源自采集笔记的选题，顺带把素材/标签深拷贝进草稿（发布要求至少一张图）
    let noteImages: Array<{ url: string }> = [];
    let noteTags: string[] = [];
    if (topic.sourceNoteId) {
      const [note] = await deps.db
        .select()
        .from(collectedNotes)
        .where(and(eq(collectedNotes.id, topic.sourceNoteId), eq(collectedNotes.userId, userId)))
        .limit(1);
      if (note) {
        noteImages = note.images.map((i) => ({ url: i.url }));
        noteTags = note.tags;
      }
    }
    const [draft] = await deps.db
      .insert(drafts)
      .values({
        userId,
        collectedNoteId: topic.sourceNoteId,
        title: topic.title,
        content: topic.angle || topic.title,
        images: noteImages,
        tags: noteTags,
      })
      .returning();
    if (!draft) return c.json({ error: "draft create failed" }, 500);
    const [updated] = await deps.db
      .update(topics)
      .set({ status: "drafted", draftId: draft.id, updatedAt: deps.now() })
      .where(eq(topics.id, topic.id))
      .returning();
    return c.json({ draft, topic: updated }, 201);
  });

  return app;
}
