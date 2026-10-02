import { describe, expect, it } from "vitest";
import type { Draft, DraftUpdateRequest } from "@v2media/shared";
import { DraftEditSession } from "../../web/src/lib/draft-edit-session";
import { authed, makeApp, registerUser } from "./helpers";

function storage() {
  const data = new Map<string, string>();
  return { get length() { return data.size; }, key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v); }, removeItem: (k: string) => { data.delete(k); } };
}
async function fixture() {
  const f = await makeApp(), auth = await registerUser(f.app), local = storage();
  const load = async (id: number) => (await f.app.request(`/api/drafts/${id}`, authed(auth.token))).json() as Promise<Draft>;
  const create = async () => (await f.app.request("/api/drafts", authed(auth.token, { method: "POST", body: JSON.stringify({ title: "原标题", content: "原正文", tags: ["原标签"] }) }))).json() as Promise<Draft>;
  const calls: DraftUpdateRequest[] = [];
  const save = async (id: number, patch: DraftUpdateRequest) => {
    calls.push(patch);
    const res = await f.app.request(`/api/drafts/${id}`, authed(auth.token, { method: "PATCH", body: JSON.stringify(patch) }));
    const body = await res.json() as any; if (!res.ok) throw Object.assign(new Error(body.error), { status: res.status }); return body as Draft;
  };
  const editor = (writerId: string, extra: Partial<ConstructorParameters<typeof DraftEditSession>[0]> = {}) =>
    new DraftEditSession({ userId: auth.userId, writerId, storage: local, save, load, active: () => true, ...extra });
  return { ...f, auth, local, load, create, calls, save, editor };
}
describe("durable authenticated draft edits with real Hono/PGlite CAS", () => {
  it("requires a base version and permits only one concurrent writer; foreign users cannot edit", async () => {
    const f = await fixture(), d = await f.create();
    expect((await f.app.request(`/api/drafts/${d.id}`, authed(f.auth.token, { method: "PATCH", body: JSON.stringify({ title: "missing version" }) }))).status).toBe(428);
    const results = await Promise.allSettled([f.save(d.id, { textVersion: 0, title: "A" }), f.save(d.id, { textVersion: 0, title: "B" })]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect((results.find(r => r.status === "rejected") as PromiseRejectedResult).reason.status).toBe(409);
    expect((await f.load(d.id)).textVersion).toBe(1);
    const other = await registerUser(f.app, "other@offline.invalid");
    expect((await f.app.request(`/api/drafts/${d.id}`, authed(other.token, { method: "PATCH", body: JSON.stringify({ textVersion: 1, content: "foreign" }) }))).status).toBe(404);
  });
  it("preserves offline text across switching/reload, without restoring it to another user", async () => {
    const f = await fixture(), a = await f.create(), b = await f.create();
    const old = f.editor("old", { save: async () => { throw new Error("offline"); } });
    old.open(a); old.change(a.id, { content: "未保存的真实编辑" }); expect(await old.flush(a.id)).toBe(false);
    old.open(b); expect(old.open(a)).toMatchObject({ state: "error", fields: { content: "未保存的真实编辑" } });
    const next = f.editor("reload"); expect(next.open(await f.load(a.id))).toMatchObject({ recovered: true, fields: { content: "未保存的真实编辑" } });
    const other = f.editor("other", { userId: f.auth.userId + 1 }); expect(other.open(a).fields.content).toBe("原正文");
    expect(await next.flush(a.id)).toBe(true); expect((await f.load(a.id)).content).toBe("未保存的真实编辑"); expect(f.local.length).toBe(0);
  });
  it("keeps two windows' outboxes separate and resolves only an explicit local choice against current CAS", async () => {
    const f = await fixture(), d = await f.create(), a = f.editor("A"), b = f.editor("B");
    a.open(d); b.open(d); a.change(d.id, { title: "窗口A标题" }); b.change(d.id, { content: "窗口B正文" }); expect(f.local.length).toBe(2);
    expect(await a.flush(d.id)).toBe(true); expect(await b.flush(d.id)).toBe(false);
    expect(b.view(d.id)).toMatchObject({ state: "conflict", fields: { content: "窗口B正文" }, server: { title: "窗口A标题" } });
    expect(await b.flush(d.id)).toBe(false); expect(f.calls).toHaveLength(2);
    expect(await b.resolve(d.id, "local")).toBe(true);
    expect(await f.load(d.id)).toMatchObject({ title: "窗口A标题", content: "窗口B正文", textVersion: 2 });
  });
  it("serializes a newer edit behind an in-flight ACK and never drops it", async () => {
    const f = await fixture(), d = await f.create(); let release!: () => void, entered!: () => void;
    const pending = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; }); let first = true;
    const editor = f.editor("writer", { save: async (id: number, patch: DraftUpdateRequest) => {
      const result = await f.save(id, patch); if (first) { first = false; entered(); await pending; } return result;
    } });
    editor.open(d); editor.change(d.id, { content: "第一次" }); const saving = editor.flush(d.id); await started;
    editor.change(d.id, { content: "等待期间继续编辑" }); release(); expect(await saving).toBe(true);
    expect(f.calls.map(c => c.textVersion)).toEqual([0, 1]); expect((await f.load(d.id)).content).toBe("等待期间继续编辑"); expect(f.local.length).toBe(0);
  });
  it("recovers an ACK lost after server commit without resending already saved text", async () => {
    const f = await fixture(), d = await f.create();
    const old = f.editor("old", { save: async (id: number, patch: DraftUpdateRequest) => { await f.save(id, patch); throw new Error("ACK lost"); } });
    old.open(d); old.change(d.id, { title: "已提交的标题" }); expect(await old.flush(d.id)).toBe(false);
    const restored = f.editor("restored"); expect(restored.open(await f.load(d.id))).toMatchObject({ state: "saved", fields: { title: "已提交的标题" } });
    expect(await restored.flush(d.id)).toBe(true); expect(f.calls).toHaveLength(1); expect(f.local.length).toBe(0);
  });
  it("a changed authorization does not transmit its pending edit and retains original-user recovery", async () => {
    const f = await fixture(), d = await f.create(); let active = true;
    const editor = f.editor("A", { active: () => active }); editor.open(d); editor.change(d.id, { tags: ["本地标签"] }); active = false;
    expect(await editor.flush(d.id)).toBe(false); expect(f.calls).toHaveLength(0); expect(f.local.length).toBe(1);
    expect(f.editor("nextA").open(d).fields.tags).toEqual(["本地标签"]);
  });
  it("ignores an older poll response and preserves local text when generation produces another version", async () => {
    const f = await fixture(), d = await f.create(), editor = f.editor("editor"); editor.open(d); editor.change(d.id, { title: "保存的新标题" }); await editor.flush(d.id);
    expect(editor.open(d).fields.title).toBe("保存的新标题");
    editor.change(d.id, { content: "本地继续写" }); await f.save(d.id, { textVersion: 1, content: "AI 新正文" });
    expect(editor.open(await f.load(d.id))).toMatchObject({ state: "conflict", fields: { content: "本地继续写" } });
    expect(await editor.resolve(d.id, "server")).toBe(true); expect(editor.view(d.id)).toMatchObject({ state: "saved", fields: { content: "AI 新正文" } });
  });
});
