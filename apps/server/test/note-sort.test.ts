import { expect, it } from "vitest";
import { collectedNotes } from "../src/db/schema";
import { authed, makeApp, registerUser } from "./helpers";

it("互动与时间全库双向排序，缺失时间置底，跨页同值无重复或遗漏且保持用户隔离", async () => {
  const { app, db } = await makeApp();
  const { token, userId } = await registerUser(app);
  const other = await registerUser(app, "other@b.co");
  const inserted = await db.insert(collectedNotes).values(Array.from({ length: 67 }, (_, index) => ({
    userId, noteId: `sort-${index}`, title: "排序样本", source: "homefeed",
    likes: index % 4, collects: index % 3, comments: index % 5,
    savedAt: new Date(Date.UTC(2026, 8, 1 + index % 4)),
    publishedAt: index % 3 === 0 ? null : new Date(Date.UTC(2026, 7, 1 + index % 5)),
  }))).returning();
  await db.insert(collectedNotes).values({ userId: other.userId, noteId: "other", title: "排序样本", likes: 9999 });
  for (const field of ["likes", "collects", "comments", "savedAt", "publishedAt"] as const) for (const direction of ["asc", "desc"] as const) {
    const actual: number[] = [];
    let cursor: string | null = null;
    do {
      const response = await app.request(`/api/notes?sort=${field}&direction=${direction}&keyword=排序样本${cursor ? `&cursor=${cursor}` : ""}`, authed(token));
      expect(response.status).toBe(200);
      const page = await response.json() as {items: Array<{id:number}>; nextCursor:string|null};
      actual.push(...page.items.map(row=>row.id)); cursor = page.nextCursor;
    } while (cursor);
    const expected = inserted.slice().sort((a,b)=>{
      const left = a[field] instanceof Date ? (a[field] as Date).getTime() : a[field];
      const right = b[field] instanceof Date ? (b[field] as Date).getTime() : b[field];
      if (left === null || right === null) return left === right ? a.id-b.id : left === null ? 1 : -1;
      return (direction === "asc" ? (left as number)-(right as number) : (right as number)-(left as number)) || a.id-b.id;
    }).map(row=>row.id);
    expect(actual).toEqual(expected);
  }
  expect((await app.request("/api/notes?sort=unknown", authed(token))).status).toBe(400);
  expect((await app.request("/api/notes?sort=likes&cursor=broken", authed(token))).status).toBe(400);
  const legacy = await (await app.request(`/api/notes?cursor=${inserted[0]!.id}`, authed(token))).json() as {items:Array<{id:number}>};
  expect(legacy.items[0]!.id).toBe(inserted[1]!.id);
});
