import { describe, expect, it } from "vitest";

import { authed, makeApp, registerUser } from "./helpers";

describe("auth", () => {
  it("register → login → authed access", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    expect(token).toBeTruthy();

    const login = await app.request("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.co", password: "hunter2x" }),
    });
    expect(login.status).toBe(200);

    const denied = await app.request("/api/notes");
    expect(denied.status).toBe(401);

    const ok = await app.request("/api/notes", authed(token));
    expect(ok.status).toBe(200);
  });
});

describe("accounts heartbeat", () => {
  it("upserts and lists accounts", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const hb = authed(token, {
      method: "POST",
      body: JSON.stringify({
        accounts: [{ xhsUserId: "u1", nickname: "小薯", subType: "creator", status: "online" }],
      }),
    });
    expect((await app.request("/api/ext/accounts/heartbeat", hb)).status).toBe(200);
    const list = (await (await app.request("/api/accounts", authed(token))).json()) as any;
    expect(list).toHaveLength(1);
    expect(list[0].nickname).toBe("小薯");
  });
});

describe("collect + notes", () => {
  it("collect upserts by noteId; notes endpoint filters", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const payload = {
      source: "search",
      items: [
        { noteId: "n1", title: "好物分享", author: { id: "u1", name: "薯", avatar: "" }, cover: "c1", likes: 12000 },
        { noteId: "n2", title: "穿搭灵感", author: { id: "u2", name: "茶", avatar: "" }, cover: "c2" },
      ],
    };
    const r1 = (await (await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify(payload) }))).json()) as any;
    expect(r1.saved).toBe(2);
    expect(r1.ids).toHaveLength(2);
    const r2 = (await (await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify(payload) }))).json()) as any;
    expect(r2.ids).toEqual(r1.ids);

    const list = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(list.items).toHaveLength(2);
    const filtered = (await (await app.request("/api/notes?keyword=穿搭", authed(token))).json()) as any;
    expect(filtered.items).toHaveLength(1);
    expect(filtered.items[0].title).toBe("穿搭灵感");
  });

  it("isolates data between users", async () => {
    const { app } = await makeApp();
    const { token: t1 } = await registerUser(app, "u1@x.yz");
    const { token: t2 } = await registerUser(app, "u2@x.yz");
    await app.request("/api/ext/collect", authed(t1, {
      method: "POST",
      body: JSON.stringify({ items: [{ noteId: "n1", title: "私密", author: {}, cover: "" }] }),
    }));
    const list = (await (await app.request("/api/notes", authed(t2))).json()) as any;
    expect(list.items).toHaveLength(0);
  });
});

describe("drafts + ai + publish", () => {
  it("full loop: collect → draft → ai rewrite → publish job → claim → result", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    await app.request("/api/ext/accounts/heartbeat", authed(token, {
      method: "POST",
      body: JSON.stringify({ accounts: [{ xhsUserId: "u1", nickname: "薯", subType: "creator" }] }),
    }));
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        items: [{ noteId: "n1", title: "原始标题", author: {}, cover: "https://cdn/c.jpg" }],
      }),
    }));
    const accounts = (await (await app.request("/api/accounts", authed(token))).json()) as any[];
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;

    const draft = (await (await app.request("/api/drafts", authed(token, {
      method: "POST",
      body: JSON.stringify({ collectedNoteId: notes.items[0].id }),
    }))).json()) as any;
    expect(draft.title).toBe("原始标题");
    expect(draft.images[0].url).toBe("https://cdn/c.jpg");

    const rw = (await (await app.request("/api/ai/rewrite", authed(token, {
      method: "POST",
      body: JSON.stringify({ draftId: draft.id }),
    }))).json()) as any;
    expect(rw.title).toBe("改写后的标题");

    const job = (await (await app.request("/api/publish/jobs", authed(token, {
      method: "POST",
      body: JSON.stringify({ draftId: draft.id, accountId: accounts[0]!.id }),
    }))).json()) as any;
    expect(job.status).toBe("pending");

    const pending = (await (await app.request(
      "/api/ext/publish/pending",
      authed(token),
    )).json()) as any;
    expect(pending.jobs).toHaveLength(1);
    expect(pending.jobs[0].draft.title).toBe("原始标题");

    expect((await app.request(`/api/ext/publish/${job.id}/claim`, authed(token, {
      method: "POST", body: JSON.stringify({ claimedBy: "sw-test" }),
    }))).status).toBe(200);
    expect((await app.request(`/api/ext/publish/${job.id}/result`, authed(token, {
      method: "POST", body: JSON.stringify({ status: "done", resultUrl: "https://xhs/n1" }),
    }))).status).toBe(200);

    const jobs = (await (await app.request("/api/publish/jobs", authed(token))).json()) as any;
    expect(jobs[0].status).toBe("done");
    const drafts = (await (await app.request("/api/drafts", authed(token))).json()) as any;
    expect(drafts[0].status).toBe("published");

    const ov = (await (await app.request("/api/overview", authed(token))).json()) as any;
    expect(ov.notes).toBe(1);
    expect(ov.accounts).toBe(1);
    expect(ov.publishSuccessRate).toBe(100);
    expect(ov.trend).toHaveLength(7);
    expect(Object.values(ov.trend[6].sources).reduce((s: number, n) => s + (n as number), 0)).toBe(1);
  });
});
