import { expect, it } from "vitest";
import { authed, makeApp, registerUser } from "./helpers";

it("authorId 筛选：列表 / 摘要 / 导出共用，只返回该作者的笔记", async () => {
  const { app } = await makeApp();
  const { token } = await registerUser(app);
  const collect = (noteId: string, userId: string, nickname: string) =>
    app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({
      source: "search", items: [{ noteId, title: `笔记 ${noteId}`, likes: 10, author: { userId, nickname } }],
    }) }));
  await collect("a1", "author-1", "作者甲");
  await collect("a2", "author-1", "作者甲");
  await collect("b1", "author-2", "作者乙");

  const list = await (await app.request("/api/notes?authorId=author-1", authed(token))).json() as { items: Array<{ noteId: string }> };
  expect(list.items.map((n) => n.noteId).sort()).toEqual(["a1", "a2"]);
  const summary = await (await app.request("/api/notes/summary?authorId=author-2", authed(token))).json() as { notes: number };
  expect(summary.notes).toBe(1);
  const csv = await (await app.request("/api/notes/export?authorId=author-1", authed(token))).text();
  expect(csv).toContain("笔记 a1");
  expect(csv).not.toContain("笔记 b1");
  const all = await (await app.request("/api/notes", authed(token))).json() as { items: unknown[] };
  expect(all.items).toHaveLength(3);
});
