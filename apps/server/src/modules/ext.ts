import { and, eq, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { collectedNotes, drafts, hostedAccounts, publishJobs } from "../db/schema";

const heartbeatSchema = z.object({
  accounts: z.array(
    z.object({
      xhsUserId: z.string().default(""),
      nickname: z.string().default(""),
      avatar: z.string().default(""),
      subType: z.enum(["pc", "creator"]).default("pc"),
      status: z.enum(["online", "expired"]).default("online"),
      statusMessage: z.string().optional(),
    }),
  ),
});

const collectSchema = z.object({
  source: z.string().default("homefeed"),
  sourceUrl: z.string().default(""),
  items: z.array(
    z.object({
      noteId: z.string(),
      xsecToken: z.string().default(""),
      type: z.enum(["video", "image", "unknown"]).default("image"),
      title: z.string().default(""),
      desc: z.string().optional(),
      author: z.object({ id: z.string().default(""), name: z.string().default(""), avatar: z.string().default("") }),
      cover: z.string().default(""),
      likes: z.number().default(0),
      collects: z.number().default(0),
      comments: z.number().default(0),
      shares: z.number().default(0),
      url: z.string().default(""),
    }),
  ),
  detail: z.object({ noteId: z.string(), title: z.string().default(""), content: z.string().default(""), images: z.array(z.string()).default([]), tags: z.array(z.string()).default([]), videoUrl: z.string().optional() }).optional(),
  comments: z.array(z.object({ commentId: z.string().default(""), nickname: z.string().default(""), avatar: z.string().default(""), content: z.string().default(""), likes: z.number().default(0), subComments: z.array(z.object({ content: z.string() })).optional() })).optional(),
  raw: z.any().optional(),
});

const claimSchema = z.object({ accountId: z.number().int() });
const resultSchema = z.object({
  status: z.enum(["done", "failed"]),
  postUrl: z.string().optional(),
  error: z.string().optional(),
});

export function extModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.post("/accounts/heartbeat", async (c) => {
    const userId = c.get("userId");
    const parsed = heartbeatSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad heartbeat" }, 400);
    const now = deps.now();
    for (const acc of parsed.data.accounts) {
      const [existing] = await deps.db
        .select()
        .from(hostedAccounts)
        .where(
          and(
            eq(hostedAccounts.userId, userId),
            eq(hostedAccounts.platform, "xhs"),
            eq(hostedAccounts.subType, acc.subType),
            eq(hostedAccounts.xhsUserId, acc.xhsUserId),
          ),
        )
        .limit(1);
      if (existing) {
        await deps.db
          .update(hostedAccounts)
          .set({
            nickname: acc.nickname || existing.nickname,
            avatar: acc.avatar || existing.avatar,
            status: acc.status,
            statusMessage: acc.statusMessage ?? "",
            lastSeenAt: now,
          })
          .where(eq(hostedAccounts.id, existing.id));
      } else {
        await deps.db.insert(hostedAccounts).values({
          userId,
          platform: "xhs",
          subType: acc.subType,
          xhsUserId: acc.xhsUserId,
          nickname: acc.nickname,
          avatar: acc.avatar,
          status: acc.status,
          statusMessage: acc.statusMessage ?? "",
          lastSeenAt: now,
        });
      }
    }
    return c.json({ ok: true });
  });

  /** 卡片批量 upsert；detail/comments 落到对应 noteId 的行。 */
  app.post("/collect", async (c) => {
    const userId = c.get("userId");
    const parsed = collectSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const p = parsed.data;
    let inserted = 0;
    for (const item of p.items) {
      const content = item.desc ?? "";
      const detail = p.detail && p.detail.noteId === item.noteId ? p.detail : null;
      const comments = p.comments && p.detail?.noteId === item.noteId ? p.comments : [];
      const values = {
        userId,
        noteId: item.noteId,
        type: item.type === "unknown" ? "image" : item.type,
        title: item.title,
        content: detail?.content || content || item.title,
        authorName: item.author.name,
        authorId: item.author.id,
        cover: item.cover,
        images: (detail?.images?.length ? detail.images : [item.cover].filter(Boolean)).map((url) => ({ url })),
        videoUrl: detail?.videoUrl ?? null,
        likes: item.likes,
        collects: item.collects,
        comments: item.comments,
        shares: item.shares,
        tags: detail?.tags ?? [],
        commentsData: comments,
        source: p.source,
        sourceUrl: p.sourceUrl || item.url,
        rawJson: p.raw ?? null,
      };
      const [existing] = await deps.db
        .select({ id: collectedNotes.id })
        .from(collectedNotes)
        .where(and(eq(collectedNotes.userId, userId), eq(collectedNotes.noteId, item.noteId)))
        .limit(1);
      if (existing) {
        await deps.db
          .update(collectedNotes)
          .set({ ...values, savedAt: deps.now() })
          .where(eq(collectedNotes.id, existing.id));
      } else {
        await deps.db.insert(collectedNotes).values(values);
        inserted++;
      }
    }
    return c.json({ ok: true, received: p.items.length, inserted });
  });

  /** 给某个账号拉一批 pending 且到期可发（或无调度）的任务，返回任务 + 草稿快照。 */
  app.get("/publish/pending", async (c) => {
    const userId = c.get("userId");
    const accountId = Number(c.req.query("accountId"));
    if (!accountId) return c.json({ error: "accountId required" }, 400);
    const rows = await deps.db
      .select({ job: publishJobs, draft: drafts })
      .from(publishJobs)
      .innerJoin(drafts, eq(publishJobs.draftId, drafts.id))
      .where(
        and(
          eq(publishJobs.userId, userId),
          eq(publishJobs.accountId, accountId),
          eq(publishJobs.status, "pending"),
          or(isNull(publishJobs.scheduledAt), lt(publishJobs.scheduledAt, deps.now())),
        ),
      )
      .orderBy(publishJobs.id)
      .limit(10);
    return c.json({
      jobs: rows.map((r) => ({
        id: r.job.id,
        visibility: r.job.visibility,
        draft: {
          id: r.draft.id,
          title: r.draft.title,
          content: r.draft.content,
          tags: r.draft.tags,
          images: r.draft.images,
        },
      })),
    });
  });

  app.post("/publish/:id/claim", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const parsed = claimSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(publishJobs)
      .set({ status: "running", claimedBy: `ext-${parsed.data.accountId}`, updatedAt: deps.now() })
      .where(
        and(eq(publishJobs.id, id), eq(publishJobs.userId, userId), eq(publishJobs.status, "pending")),
      )
      .returning();
    if (!row) return c.json({ error: "not found or already claimed" }, 404);
    return c.json(row);
  });

  app.post("/publish/:id/result", async (c) => {
    const userId = c.get("userId");
    const id = Number(c.req.param("id"));
    const parsed = resultSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [row] = await deps.db
      .update(publishJobs)
      .set({
        status: parsed.data.status,
        resultUrl: parsed.data.postUrl,
        error: parsed.data.error,
        updatedAt: deps.now(),
      })
      .where(and(eq(publishJobs.id, id), eq(publishJobs.userId, userId)))
      .returning();
    if (!row) return c.json({ error: "not found" }, 404);
    if (parsed.data.status === "done") {
      await deps.db
        .update(drafts)
        .set({ status: "published", updatedAt: deps.now() })
        .where(eq(drafts.id, row.draftId));
    }
    return c.json({ ok: true });
  });

  return app;
}
