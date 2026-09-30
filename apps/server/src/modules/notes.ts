import { and, asc, eq, gt, gte, inArray, lt, ilike, isNull, or, sql } from "drizzle-orm";
import type { NoteSortField, NoteSortDirection } from "@v2media/shared";
import { Hono } from "hono";

import type { Deps } from "../context";
import { collectedNotes, collections } from "../db/schema";

const PAGE = 30;
const MAX_BATCH = 200;
const withAvatar = <T extends { rawJson: unknown }>(row: T) => ({
  ...row, authorAvatar: (row.rawJson as { authorAvatar?: string } | null)?.authorAvatar ?? "",
});

type Query = (name: string) => string | undefined;

/** 列表与导出共用的筛选：keyword / source / tag / collectionId / type / minLikes / withinDays / ids。 */
function filterConds(userId: number, q: Query, now: Date) {
  const conds = [eq(collectedNotes.userId, userId)];
  const keyword = (q("keyword") ?? "").trim();
  const source = (q("source") ?? "").trim();
  const tag = (q("tag") ?? "").trim();
  if (keyword) {
    const like = `%${keyword}%`;
    conds.push(or(ilike(collectedNotes.title, like), ilike(collectedNotes.authorName, like))!);
  }
  if (source) conds.push(eq(collectedNotes.source, source));
  // collectionId：数字=该库；字面量 "none"=只看未分组的
  const collectionId = (q("collectionId") ?? "").trim();
  if (collectionId === "none") {
    conds.push(sql`${collectedNotes.collectionId} IS NULL`);
  } else if (collectionId) {
    const n = Number(collectionId);
    if (!Number.isInteger(n)) return { error: "bad collectionId" } as const;
    conds.push(eq(collectedNotes.collectionId, n));
  }
  if (tag) conds.push(sql`${collectedNotes.tags} @> ${JSON.stringify([tag])}::jsonb`);
  const type = (q("type") ?? "").trim();
  if (type) {
    if (type !== "image" && type !== "video") return { error: "bad type" } as const;
    conds.push(eq(collectedNotes.type, type));
  }
  const minLikes = (q("minLikes") ?? "").trim();
  if (minLikes) {
    const n = Number(minLikes);
    if (!Number.isSafeInteger(n) || n < 0) return { error: "bad minLikes" } as const;
    conds.push(gte(collectedNotes.likes, n));
  }
  // 发布时间在最近 N 天内；没采到发布时间的不匹配（不能拿采集时间代替）
  const withinDays = (q("withinDays") ?? "").trim();
  if (withinDays) {
    const n = Number(withinDays);
    if (!Number.isInteger(n) || n < 1 || n > 3650) return { error: "bad withinDays" } as const;
    conds.push(gte(collectedNotes.publishedAt, new Date(now.getTime() - n * 86_400_000)));
  }
  const ids = (q("ids") ?? "").trim();
  if (ids) {
    const list = ids.split(",").map(Number);
    if (list.length > MAX_BATCH || !list.every((n) => Number.isSafeInteger(n) && n > 0)) return { error: "bad ids" } as const;
    conds.push(inArray(collectedNotes.id, list));
  }
  return { conds } as const;
}

export function notesModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const sort = (c.req.query("sort") ?? "id") as NoteSortField;
    const direction = (c.req.query("direction") ?? (sort === "id" ? "asc" : "desc")) as NoteSortDirection;
    if (!["id", "likes", "collects", "comments", "savedAt", "publishedAt"].includes(sort) || !["asc", "desc"].includes(direction)) return c.json({ error: "bad sort" }, 400);
    const isTime = sort === "savedAt" || sort === "publishedAt";
    // Match JavaScript Date's millisecond precision for stable cursor equality.
    const column = isTime ? sql`floor(extract(epoch from ${collectedNotes[sort]}) * 1000)` : sql`${collectedNotes[sort]}`;
    const filtered = filterConds(userId, (n) => c.req.query(n), deps.now());
    if ("error" in filtered) return c.json({ error: filtered.error }, 400);
    const conds = filtered.conds;
    const rawCursor = c.req.query("cursor");
    if (rawCursor) {
      try {
        const cursor = /^\d+$/.test(rawCursor) && sort === "id" && direction === "asc"
          ? { sort, direction, id: Number(rawCursor), value: Number(rawCursor) }
          : JSON.parse(Buffer.from(rawCursor, "base64url").toString("utf8"));
        if (cursor.sort !== sort || cursor.direction !== direction || !Number.isSafeInteger(cursor.id) || cursor.id < 1 || !(cursor.value === null && sort === "publishedAt" || Number.isSafeInteger(cursor.value) && cursor.value >= 0)) throw new Error("bad cursor");
        conds.push(cursor.value === null ? and(isNull(column), gt(collectedNotes.id, cursor.id))! : or(
          direction === "asc" ? gt(column, cursor.value) : lt(column, cursor.value),
          and(eq(column, cursor.value), gt(collectedNotes.id, cursor.id)),
          ...(sort === "publishedAt" ? [isNull(column)] : []),
        )!);
      } catch { return c.json({ error: "bad cursor" }, 400); }
    }
    const rows = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(...conds))
      .orderBy(direction === "asc" ? sql`${column} asc nulls last` : sql`${column} desc nulls last`, asc(collectedNotes.id))
      .limit(PAGE + 1);
    const items = rows.slice(0, PAGE);
    return c.json({
      items: items.map(withAvatar),
      nextCursor: rows.length > PAGE ? Buffer.from(JSON.stringify({ sort, direction, id: items.at(-1)!.id, value: isTime ? (items.at(-1)![sort] as Date | null)?.getTime() ?? null : items.at(-1)![sort] })).toString("base64url") : null,
    });
  });

  /** 导出当前筛选为 CSV（UTF-8 BOM，Excel 双击直接开不乱码）。
   *  与列表同一套筛选：collectionId + keyword + source + tag。 */
  app.get("/export", async (c) => {
    const userId = c.get("userId");
    const collectionId = (c.req.query("collectionId") ?? "").trim();
    const filtered = filterConds(userId, (n) => c.req.query(n), deps.now());
    if ("error" in filtered) return c.json({ error: filtered.error }, 400);
    const conds = filtered.conds;
    const rows = await deps.db
      .select({
        title: collectedNotes.title,
        type: collectedNotes.type,
        authorName: collectedNotes.authorName,
        likes: collectedNotes.likes,
        collects: collectedNotes.collects,
        comments: collectedNotes.comments,
        shares: collectedNotes.shares,
        publishedAt: collectedNotes.publishedAt,
        ipLocation: collectedNotes.ipLocation,
        sourceKeyword: collectedNotes.sourceKeyword,
        tags: collectedNotes.tags,
        commentsData: collectedNotes.commentsData,
        sourceUrl: collectedNotes.sourceUrl,
        savedAt: collectedNotes.savedAt,
      })
      .from(collectedNotes)
      .where(and(...conds))
      .orderBy(collectedNotes.id)
      .limit(5000);

    const cell = (v: unknown) => {
      const s = v == null ? "" : String(v);
      // 防 CSV 公式注入：= + - @ / 制表符开头加前导单引号
      const safe = /^\s*[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const hot = (r: (typeof rows)[number]) =>
      (Array.isArray(r.commentsData) ? r.commentsData : [])
        .slice()
        .sort((a: any, b: any) => (b.likes ?? 0) - (a.likes ?? 0))
        .slice(0, 3)
        .map((cm: any) => `${cm.userName || "?"}:${cm.content}(${cm.likes ?? 0}赞)`)
        .join(" | ");
    const daily = (r: (typeof rows)[number]) => {
      if (!r.publishedAt) return "";
      // 与分析口径一致：整天数向上取整、最少 1 天
      const days = Math.max(
        1,
        Math.ceil((deps.now().getTime() - r.publishedAt.getTime()) / 86_400_000),
      );
      return Math.round(
        (r.likes + r.collects + r.comments + r.shares) / days,
      );
    };

    const header = [
      "标题", "类型", "作者", "赞", "收藏", "评论", "分享", "总互动", "日均互动",
      "发布时间", "IP属地", "搜索来源词", "标签", "热门评论TOP3", "原链接", "入库时间",
    ];
    const lines = rows.map((r) =>
      [
        r.title, r.type === "video" ? "视频" : "图文", r.authorName,
        r.likes, r.collects, r.comments, r.shares,
        r.likes + r.collects + r.comments + r.shares,
        daily(r),
        r.publishedAt ? r.publishedAt.toISOString().slice(0, 10) : "",
        r.ipLocation ?? "",
        r.sourceKeyword ?? "",
        (Array.isArray(r.tags) ? r.tags : []).join(" "),
        hot(r),
        r.sourceUrl ?? "",
        r.savedAt.toISOString().slice(0, 10),
      ].map(cell).join(","),
    );
    const csv = "﻿" + [header.map(cell).join(","), ...lines].join("\r\n");
    const name = `notes-${collectionId || "all"}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
      },
    });
  });

  /** 批量操作：move（移入库，collectionId=null 即移出）/ delete。只作用于当前用户的笔记。 */
  app.post("/batch", async (c) => {
    const userId = c.get("userId");
    const body = await c.req.json().catch(() => null) as
      | { action?: string; ids?: unknown; collectionId?: number | null } | null;
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH
      || !ids.every((n) => Number.isSafeInteger(n) && n > 0)) return c.json({ error: "bad ids" }, 400);
    const scope = and(eq(collectedNotes.userId, userId), inArray(collectedNotes.id, ids as number[]));
    if (body?.action === "delete") {
      const gone = await deps.db.delete(collectedNotes).where(scope).returning({ id: collectedNotes.id });
      return c.json({ affected: gone.length });
    }
    if (body?.action === "move") {
      const target = body.collectionId ?? null;
      if (target !== null) {
        if (!Number.isSafeInteger(target)) return c.json({ error: "bad collectionId" }, 400);
        const [col] = await deps.db.select({ id: collections.id }).from(collections)
          .where(and(eq(collections.id, target), eq(collections.userId, userId))).limit(1);
        if (!col) return c.json({ error: "collection not found" }, 404);
      }
      const moved = await deps.db.update(collectedNotes).set({ collectionId: target })
        .where(scope).returning({ id: collectedNotes.id });
      return c.json({ affected: moved.length });
    }
    return c.json({ error: "bad action" }, 400);
  });

  app.get("/:id", async (c) => {
    const [row] = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(eq(collectedNotes.id, Number(c.req.param("id"))), eq(collectedNotes.userId, c.get("userId"))))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(withAvatar(row));
  });

  app.delete("/:id", async (c) => {
    await deps.db
      .delete(collectedNotes)
      .where(and(eq(collectedNotes.id, Number(c.req.param("id"))), eq(collectedNotes.userId, c.get("userId"))));
    return c.json({ ok: true });
  });

  return app;
}
