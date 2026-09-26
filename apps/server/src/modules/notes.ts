import { and, eq, gt, ilike, or, sql } from "drizzle-orm";
import { Hono } from "hono";

import type { Deps } from "../context";
import { collectedNotes } from "../db/schema";

const PAGE = 30;

export function notesModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  app.get("/", async (c) => {
    const userId = c.get("userId");
    const cursor = Number(c.req.query("cursor") ?? 0);
    const keyword = (c.req.query("keyword") ?? "").trim();
    const source = (c.req.query("source") ?? "").trim();
    const tag = (c.req.query("tag") ?? "").trim();
    const conds = [eq(collectedNotes.userId, userId), gt(collectedNotes.id, cursor)];
    if (keyword) {
      const like = `%${keyword}%`;
      conds.push(or(ilike(collectedNotes.title, like), ilike(collectedNotes.authorName, like))!);
    }
    if (source) conds.push(eq(collectedNotes.source, source));
    // collectionId：数字=该库；字面量 "none"=只看未分组的
    const collectionId = (c.req.query("collectionId") ?? "").trim();
    if (collectionId === "none") {
      conds.push(sql`${collectedNotes.collectionId} IS NULL`);
    } else if (collectionId) {
      const n = Number(collectionId);
      if (!Number.isInteger(n)) return c.json({ error: "bad collectionId" }, 400);
      conds.push(eq(collectedNotes.collectionId, n));
    }
    if (tag) conds.push(sql`${collectedNotes.tags} @> ${JSON.stringify([tag])}::jsonb`);
    const rows = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(...conds))
      .orderBy(collectedNotes.id)
      .limit(PAGE + 1);
    const items = rows.slice(0, PAGE);
    return c.json({
      items,
      nextCursor: rows.length > PAGE ? items[items.length - 1]!.id : null,
    });
  });

  /** 导出当前筛选为 CSV（UTF-8 BOM，Excel 双击直接开不乱码）。 */
  app.get("/export", async (c) => {
    const userId = c.get("userId");
    const collectionId = (c.req.query("collectionId") ?? "").trim();
    const conds = [eq(collectedNotes.userId, userId)];
    if (collectionId === "none") {
      conds.push(sql`${collectedNotes.collectionId} IS NULL`);
    } else if (collectionId) {
      const n = Number(collectionId);
      if (!Number.isInteger(n)) return c.json({ error: "bad collectionId" }, 400);
      conds.push(eq(collectedNotes.collectionId, n));
    }
    const rows = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(...conds))
      .orderBy(collectedNotes.id)
      .limit(5000);

    const cell = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
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
      const days = Math.max(
        (deps.now().getTime() - r.publishedAt.getTime()) / 86400000,
        0.04,
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

  app.get("/:id", async (c) => {
    const [row] = await deps.db
      .select()
      .from(collectedNotes)
      .where(and(eq(collectedNotes.id, Number(c.req.param("id"))), eq(collectedNotes.userId, c.get("userId"))))
      .limit(1);
    if (!row) return c.json({ error: "not found" }, 404);
    return c.json(row);
  });

  app.delete("/:id", async (c) => {
    await deps.db
      .delete(collectedNotes)
      .where(and(eq(collectedNotes.id, Number(c.req.param("id"))), eq(collectedNotes.userId, c.get("userId"))));
    return c.json({ ok: true });
  });

  return app;
}
