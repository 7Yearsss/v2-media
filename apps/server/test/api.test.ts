import { describe, expect, it } from "vitest";

import { authed, drainAiRuns, claimBrowser, makeApp, registerUser, reportBrowser } from "./helpers";

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
  it("完整详情的互动数优先于列表卡片的缺省零值", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const res = await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        source: "detail",
        items: [{ noteId: "detail-stats", title: "测试笔记", likes: 21 }],
        details: [{
          noteId: "detail-stats", title: "测试笔记", content: "完整正文",
          likes: 23, collects: 6, comments: 4, shares: 2,
          commentsData: [{ commentId: "c1", content: "评论内容" }],
        }],
      }),
    }));
    expect(res.status).toBe(200);
    const { ids } = await res.json() as { ids: number[] };
    const note = await (await app.request(`/api/notes/${ids[0]}`, authed(token))).json() as any;
    expect({ likes: note.likes, collects: note.collects, comments: note.comments, shares: note.shares })
      .toEqual({ likes: 23, collects: 6, comments: 4, shares: 2 });
  });

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

  it("collections: create/list/filter/move/delete", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    // 建库
    const col = (await (await app.request("/api/collections", authed(token, {
      method: "POST", body: JSON.stringify({ name: "健身" }),
    }))).json()) as any;
    expect(col.id).toBeGreaterThan(0);
    // 同名幂等
    const dup = (await (await app.request("/api/collections", authed(token, {
      method: "POST", body: JSON.stringify({ name: "健身" }),
    }))).json()) as any;
    expect(dup.id).toBe(col.id);
    // 采集进库
    const payload = {
      collectionId: col.id,
      items: [{ noteId: "g1", title: "增肌餐", author: {}, cover: "" }],
    };
    const r = (await (await app.request("/api/ext/collect", authed(token, {
      method: "POST", body: JSON.stringify(payload),
    }))).json()) as any;
    expect(r.saved).toBe(1);
    // 列表带计数
    const cols = (await (await app.request("/api/collections", authed(token))).json()) as any;
    expect(cols.items[0].noteCount).toBe(1);
    // 按库筛选 / 未分组筛选
    const inCol = (await (await app.request(`/api/notes?collectionId=${col.id}`, authed(token))).json()) as any;
    expect(inCol.items).toHaveLength(1);
    const none = (await (await app.request("/api/notes?collectionId=none", authed(token))).json()) as any;
    expect(none.items).toHaveLength(0);
    // 别人的 collectionId 不能用
    const { token: t2 } = await registerUser(app, "other@x.yz");
    const bad = await app.request("/api/ext/collect", authed(t2, {
      method: "POST", body: JSON.stringify(payload),
    }));
    expect(bad.status).toBe(400);
    // 删库：笔记回未分组
    expect((await app.request(`/api/collections/${col.id}`, authed(token, { method: "DELETE" }))).status).toBe(200);
    const after = (await (await app.request("/api/notes?collectionId=none", authed(token))).json()) as any;
    expect(after.items).toHaveLength(1);
    expect(after.items[0].collectionId).toBeNull();
  });

  it("notes: 范围筛选 + 批量移库/删除 + 按 ids 导出", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const post = (path: string, body: unknown) =>
      app.request(path, authed(token, { method: "POST", body: JSON.stringify(body) }));
    await post("/api/ext/collect", {
      source: "search",
      items: [
        { noteId: "f1", title: "低赞图文", likes: 50 },
        { noteId: "f2", title: "高赞图文", likes: 5000 },
        { noteId: "f3", title: "高赞视频", likes: 8000, type: "video" },
      ],
    });
    const list = async (qs: string) => ((await (await app.request(`/api/notes?${qs}`, authed(token))).json()) as any).items;
    expect(await list("minLikes=1000")).toHaveLength(2);
    expect(await list("minLikes=1000&type=video")).toHaveLength(1);
    // 没采到发布时间的笔记不匹配时间范围
    expect(await list("withinDays=7")).toHaveLength(0);
    expect((await app.request("/api/notes?minLikes=-1", authed(token))).status).toBe(400);
    expect((await app.request("/api/notes?type=gif", authed(token))).status).toBe(400);

    const summary = (await (await app.request("/api/notes/summary?minLikes=1000", authed(token))).json()) as any;
    expect(summary).toMatchObject({ notes: 2, likes: 13000, withDetail: 0, topTags: [] });

    const all = await list("");
    const ids = all.map((n: any) => n.id);
    const col = (await (await post("/api/collections", { name: "批量" })).json()) as any;
    const moved = (await (await post("/api/notes/batch", { action: "move", ids: ids.slice(0, 2), collectionId: col.id })).json()) as any;
    expect(moved.affected).toBe(2);
    expect(await list(`collectionId=${col.id}`)).toHaveLength(2);
    // 别人的库、非法 ids、未知动作
    const { token: t2 } = await registerUser(app, "other2@x.yz");
    const foreign = await app.request("/api/notes/batch", authed(t2, { method: "POST", body: JSON.stringify({ action: "move", ids, collectionId: col.id }) }));
    expect(foreign.status).toBe(404);
    expect((await post("/api/notes/batch", { action: "move", ids: [] })).status).toBe(400);
    expect((await post("/api/notes/batch", { action: "nope", ids })).status).toBe(400);
    // 别人的笔记 id 不会被删
    const stolen = (await (await app.request("/api/notes/batch", authed(t2, { method: "POST", body: JSON.stringify({ action: "delete", ids }) }))).json()) as any;
    expect(stolen.affected).toBe(0);
    // 移出库
    await post("/api/notes/batch", { action: "move", ids, collectionId: null });
    expect(await list(`collectionId=${col.id}`)).toHaveLength(0);

    const csv = await (await app.request(`/api/notes/export?ids=${ids[0]}`, authed(token))).text();
    expect(csv.trim().split("\r\n")).toHaveLength(2);
    const del = (await (await post("/api/notes/batch", { action: "delete", ids: ids.slice(0, 2) })).json()) as any;
    expect(del.affected).toBe(2);
    expect(await list("")).toHaveLength(1);
  });

  it("collection analyze: AI 报告落库 + 越权 404 + 空库 400", async () => {
    const { app, deps } = await makeApp({ complete: async () => JSON.stringify({ summary: "训练样本值得继续观察", findings: [], needs: [], traps: [], ideas: [{ title: "训练准备步骤", hook: "先准备", angle: "保留样本依据", refs: [1] }] }) });
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, {
      method: "POST", body: JSON.stringify({ name: "健身" }),
    }))).json()) as any;
    // 空库 → 400
    expect((await app.request(`/api/collections/${col.id}/analyze`, authed(token, { method: "POST" }))).status).toBe(400);
    // 采两篇再分析
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        collectionId: col.id,
        items: [
          { noteId: "a1", title: "燃脂训练", author: {}, cover: "", likes: 9000, comments: 300 },
          { noteId: "a2", title: "增肌餐", author: {}, cover: "", likes: 50 },
        ],
      }),
    }));
    const started = await app.request(`/api/collections/${col.id}/analyze`, authed(token, { method: "POST" }));
    // 异步：立刻 202 + running，后台跑完后详情变 done
    expect(started.status).toBe(202);
    const run = (await started.json()) as any;
    expect(run.status).toBe("running");
    await drainAiRuns(deps);
    let ana: any = run;
    for (let i = 0; i < 100 && ana.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ana = (await (await app.request(`/api/collections/${col.id}/analyses/${run.id}`, authed(token))).json()) as any;
    }
    expect(ana.status).toBe("done");
    expect(ana.noteCount).toBe(2);
    expect(ana.report.length).toBeGreaterThan(0);
    // 结构化统计：topNotes 按互动排序、total 正确
    expect(ana.data.stats.totalNotes).toBe(2);
    expect(ana.data.stats.topNotes[0].title).toBe("燃脂训练");
    expect(ana.data.stats.totalLikes).toBe(9050);
    // 历史列表 + 详情
    const hist = (await (await app.request(`/api/collections/${col.id}/analyses`, authed(token))).json()) as any;
    expect(hist.items).toHaveLength(1);
    const detail = (await (await app.request(`/api/collections/${col.id}/analyses/${ana.id}`, authed(token))).json()) as any;
    expect(detail.report).toBe(ana.report);
    // 别人的库/报告 → 404
    const { token: t2 } = await registerUser(app, "other@x.yz");
    expect((await app.request(`/api/collections/${col.id}/analyze`, authed(t2, { method: "POST" }))).status).toBe(404);
    expect((await app.request(`/api/collections/${col.id}/analyses`, authed(t2))).status).toBe(404);
  });

  it("title fallback: 兜底标题可被真标题替换", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    // 无标题卡片 → 兜底
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({ items: [{ noteId: "t1", title: "", desc: "晨起训练记录正文", author: {}, cover: "" }] }),
    }));
    let list = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(list.items[0].title).toBe("晨起训练记录正文");
    // 之后带真标题的卡片进来 → 替换
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({ items: [{ noteId: "t1", title: "晨跑 5 公里计划", author: {}, cover: "" }] }),
    }));
    list = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(list.items[0].title).toBe("晨跑 5 公里计划");
    // 真标题后再来一次空标题卡片 → 真标题不被冲掉
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({ items: [{ noteId: "t1", title: "", desc: "别的正文", author: {}, cover: "" }] }),
    }));
    list = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(list.items[0].title).toBe("晨跑 5 公里计划");
  });

  it("media quality tiers: free 压缩 / pro 原画质", async () => {
    const { mediaQualityForPlan } = await import("../src/lib/media-store");
    const free = mediaQualityForPlan("free");
    const pro = mediaQualityForPlan("pro");
    expect(free.keepOriginal).toBe(false);
    expect(free.imageMaxWidth).toBeGreaterThan(0);
    expect(free.videoMaxBytes).toBeLessThan(pro.videoMaxBytes);
    expect(pro.keepOriginal).toBe(true);
    expect(mediaQualityForPlan("unknown")).toEqual(free);
  });

  it("detail 溯源字段落库: publishedAt / ipLocation / sourceKeyword", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        source: "search",
        context: { keyword: "健身" },
        items: [],
        details: [{ noteId: "d1", title: "深蹲教程", publishedAt: "1700000000000", ipLocation: "北京", author: {} }],
      }),
    }));
    const list = (await (await app.request("/api/notes", authed(token))).json()) as any;
    const n = list.items[0];
    expect(n.sourceKeyword).toBe("健身");
    expect(n.ipLocation).toBe("北京");
    expect(new Date(n.publishedAt).getTime()).toBe(1700000000000);
  });

  it("不完整详情重传保留已有评论、正文和素材", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const collect = (details: unknown[]) =>
      app.request("/api/ext/collect", authed(token, {
        method: "POST",
        body: JSON.stringify({ source: "detail", items: [], details }),
      }));
    // 先落一篇带评论的详情，再重传同 noteId 的无评论详情（嗅探时机丢评论的场景）
    await collect([{
      noteId: "c1", title: "带评论", author: {}, cover: "c",
      content: "完整正文", images: [{ url: "https://cdn/image.jpg" }],
      tags: ["标签"], videoUrl: "https://cdn/video.mp4",
      commentsData: [{ commentId: "k1", userName: "薯友", content: "求链接", likes: 9 }],
    }]);
    await collect([{ noteId: "c1", title: "带评论", author: {}, cover: "c" }]);
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(notes.items).toHaveLength(1);
    expect(notes.items[0].commentsData?.[0]?.content).toBe("求链接");
    expect(notes.items[0].content).toBe("完整正文");
    expect(notes.items[0].images).toEqual([{ url: "https://cdn/image.jpg" }]);
    expect(notes.items[0].tags).toEqual(["标签"]);
    expect(notes.items[0].videoUrl).toBe("https://cdn/video.mp4");
  });

  it("多页评论分批入库与旧页重放不会丢失评论或回复", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const upload = (commentsData: unknown[]) => app.request("/api/ext/collect", authed(token, {
      method: "POST", body: JSON.stringify({ source: "detail", items: [], details: [{
        noteId: "paged-comments", title: "多页评论", author: {}, comments: 3, commentsData,
      }] }),
    }));
    const first = { commentId: "c1", userName: "一", content: "第一页", likes: 1,
      subComments: [{ commentId: "r1", userName: "回复一", content: "回复", likes: 2 }] };
    await upload([first]);
    await upload([{ commentId: "c2", userName: "二", content: "第二页", likes: 3 }]);
    await upload([{ ...first, subComments: [{ commentId: "r2", userName: "回复二", content: "新回复", likes: 4 }] }]);
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(notes.items).toHaveLength(1);
    expect(notes.items[0].commentsData.map((c: any) => c.commentId)).toEqual(["c1", "c2"]);
    expect(notes.items[0].commentsData[0].subComments.map((c: any) => c.commentId)).toEqual(["r1", "r2"]);
    expect(notes.items[0].commentsData[0].subComments[0].userName).toBe("回复一");
  });

  it("notes export: CSV 按库过滤 + 含 BOM + 转义逗号", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, {
      method: "POST", body: JSON.stringify({ name: "导出库" }),
    }))).json()) as any;
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        collectionId: col.id,
        items: [{ noteId: "e1", title: "有,逗号的标题", author: {}, likes: 5 }],
      }),
    }));
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({ items: [{ noteId: "e2", title: "别的库外的", author: {} }] }),
    }));
    const res = await app.request(
      `/api/notes/export?collectionId=${col.id}`, authed(token));
    expect(res.status).toBe(200);
    // res.text() 会吃掉 BOM，按字节验 EF BB BF
    expect([...new Uint8Array((await res.arrayBuffer()).slice(0, 3))])
      .toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder().decode(
      await (await app.request(`/api/notes/export?collectionId=${col.id}`, authed(token))).arrayBuffer(),
    );
    expect(csv).toContain("标题,类型,作者");
    expect(csv).toContain('"有,逗号的标题"'); // 含逗号字段被引用
    expect(csv).not.toContain("别的库外的"); // 只导出所选库
    // keyword/source 与列表同一套筛选
    const kw = await (await app.request(
      `/api/notes/export?collectionId=${col.id}&keyword=${encodeURIComponent("不存在词")}`,
      authed(token))).text();
    expect(kw).not.toContain("有,逗号");
    const src = await (await app.request(
      `/api/notes/export?collectionId=${col.id}&source=search`, authed(token))).text();
    expect(src).not.toContain("有,逗号");
    // 公式注入：以 = 开头的值被加前导单引号
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        collectionId: col.id,
        items: [{ noteId: "e3", title: "=cmd|'/c calc'!A1", author: {} }],
      }),
    }));
    const inj = await (await app.request(
      `/api/notes/export?collectionId=${col.id}&keyword=cmd`, authed(token))).text();
    expect(inj).toContain("'=cmd");
    // 导出接口不吐别人的数据
    const { token: t2 } = await registerUser(app, "exp@x.yz");
    const res2 = await app.request("/api/notes/export", authed(t2));
    expect((await res2.text())).not.toContain("有,逗号");
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

    expect((await claimBrowser(app, token, "publish", job.id)).status).toBe(200);
    expect((await reportBrowser(app, token, "publish", job.id, { status: "done", resultUrl: "https://xhs/n1" })).status).toBe(200);

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

describe("topics 选题池", () => {
  it("CRUD + plannedAt 驱动状态流转 + 越权 404", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const t = (await (await app.request("/api/topics", authed(token, {
      method: "POST", body: JSON.stringify({ title: "露营装备清单" }),
    }))).json()) as any;
    expect(t.status).toBe("idea");
    expect(t.sourceType).toBe("manual");
    const detail = await app.request(`/api/topics/${t.id}`, authed(token));
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ id: t.id, title: "露营装备清单" });
    // plannedAt → planned；清空 → idea
    const planned = (await (await app.request(`/api/topics/${t.id}`, authed(token, {
      method: "PATCH", body: JSON.stringify({ plannedAt: Date.now() + 86400_000 }),
    }))).json()) as any;
    expect(planned.status).toBe("planned");
    const unplanned = (await (await app.request(`/api/topics/${t.id}`, authed(token, {
      method: "PATCH", body: JSON.stringify({ plannedAt: null }),
    }))).json()) as any;
    expect(unplanned.status).toBe("idea");
    expect(unplanned.plannedAt).toBeNull();
    // 手动流转系统状态 → 400
    expect((await app.request(`/api/topics/${t.id}`, authed(token, {
      method: "PATCH", body: JSON.stringify({ status: "drafted" }),
    }))).status).toBe(400);
    // 归档 → 恢复
    expect(((await (await app.request(`/api/topics/${t.id}`, authed(token, {
      method: "PATCH", body: JSON.stringify({ status: "archived" }),
    }))).json()) as any).status).toBe("archived");
    // 状态过滤
    const inArchived = (await (await app.request("/api/topics?status=archived", authed(token))).json()) as any;
    expect(inArchived.items).toHaveLength(1);
    // 越权
    const { token: t2 } = await registerUser(app, "other@x.yz");
    expect((await app.request(`/api/topics/${t.id}`, authed(t2))).status).toBe(404);
    expect((await app.request(`/api/topics/${t.id}`, authed(t2, { method: "DELETE" }))).status).toBe(404);
  });

  it("to-draft 幂等 + 发布成功后回流 published", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    await app.request("/api/ext/accounts/heartbeat", authed(token, {
      method: "POST",
      body: JSON.stringify({ accounts: [{ xhsUserId: "u1", nickname: "薯", subType: "creator" }] }),
    }));
    const accounts = (await (await app.request("/api/accounts", authed(token))).json()) as any[];
    // 采集一篇带图笔记，选题挂它 → to-draft 会把图带进草稿（发布要求有图）
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        items: [{ noteId: "s1", title: "减脂餐", author: {}, cover: "https://cdn/s1.jpg" }],
      }),
    }));
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;
    const topic = (await (await app.request("/api/topics", authed(token, {
      method: "POST",
      body: JSON.stringify({ title: "减脂餐单", angle: "七天不重样", sourceNoteId: notes.items[0].id }),
    }))).json()) as any;
    expect(topic.sourceType).toBe("note");
    const r1 = (await (await app.request(`/api/topics/${topic.id}/to-draft`, authed(token, {
      method: "POST",
    }))).json()) as any;
    expect(r1.topic.status).toBe("drafted");
    expect(r1.draft.content).toContain("七天不重样");
    expect(r1.draft.images[0].url).toBe("https://cdn/s1.jpg");
    // 幂等：再调一次返回同一草稿
    const r2 = (await (await app.request(`/api/topics/${topic.id}/to-draft`, authed(token, {
      method: "POST",
    }))).json()) as any;
    expect(r2.draft.id).toBe(r1.draft.id);
    // 发布跑完 → 选题 published + publishJobId
    const job = (await (await app.request("/api/publish/jobs", authed(token, {
      method: "POST", body: JSON.stringify({ draftId: r1.draft.id, accountId: accounts[0]!.id }),
    }))).json()) as any;
    await claimBrowser(app, token, "publish", job.id);
    await reportBrowser(app, token, "publish", job.id, { status: "done", resultUrl: "https://xhs/x" });
    const topics = (await (await app.request("/api/topics", authed(token))).json()) as any;
    expect(topics.items[0].status).toBe("published");
    expect(topics.items[0].publishJobId).toBe(job.id);
  });

  it("ai/topics: 库爆款 → 生成入池 + 服务端加权分", async () => {
    const ai = {
      complete: async () =>
        JSON.stringify({
          topics: [
            {
              title: "宿舍减脂餐",
              angle: "不开火场景",
              scoreDetail: { traffic: 10, fit: 10, diff: 10, monetization: 10, evergreen: 10, cost: 10, risk: 10 },
              reason: "燃脂训练 9k 赞验证了赛道",
            },
            { title: "极简版", scoreDetail: { traffic: 5, fit: 5, diff: 5, monetization: 5, evergreen: 5, cost: 5, risk: 5 } },
          ],
        }),
    };
    const { app, deps } = await makeApp(ai);
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, {
      method: "POST", body: JSON.stringify({ name: "健身" }),
    }))).json()) as any;
    // 空库 → 400
    expect((await app.request("/api/ai/topics", authed(token, {
      method: "POST", body: JSON.stringify({ collectionId: col.id }),
    }))).status).toBe(400);
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({
        collectionId: col.id,
        items: [{ noteId: "a1", title: "燃脂训练", author: {}, cover: "", likes: 9000 }],
      }),
    }));
    const res = (await (await app.request("/api/ai/topics", authed(token, {
      method: "POST", body: JSON.stringify({ collectionId: col.id, count: 5 }),
    }))).json()) as any;
    expect(res.status).toBe("queued");
    await drainAiRuns(deps);
    const done = await (await app.request(`/api/ai/runs/${res.id}`, authed(token))).json() as any;
    expect(done.status).toBe("done");
    const generated = await (await app.request("/api/topics", authed(token))).json() as any;
    res.items = generated.items.sort((a: any, b: any) => a.id - b.id);
    expect(res.items).toHaveLength(2);
    expect(res.items[0].score).toBe(100);
    expect(res.items[0].sourceType).toBe("ai");
    expect(res.items[0].collectionId).toBe(col.id);
    expect(res.items[0].angle).toContain("推荐理由");
    expect(res.items[1].score).toBe(50); // 模型明确给七维5分 → 50
    // 越权 collection → 404
    const { token: t2 } = await registerUser(app, "other@x.yz");
    expect((await app.request("/api/ai/topics", authed(t2, {
      method: "POST", body: JSON.stringify({ collectionId: col.id }),
    }))).status).toBe(404);
  });

  it("ai/topic-score: 回写七维分 + verdict/advice", async () => {
    const ai = {
      complete: async () =>
        JSON.stringify({
          scoreDetail: { traffic: 8, fit: 9, diff: 6, monetization: 5, evergreen: 7, cost: 8, risk: 9 },
          verdict: "做",
          advice: "先发一条测试流量",
        }),
    };
    const { app, deps } = await makeApp(ai);
    const { token } = await registerUser(app);
    const topic = (await (await app.request("/api/topics", authed(token, {
      method: "POST", body: JSON.stringify({ title: "早八穿搭" }),
    }))).json()) as any;
    const res = (await (await app.request("/api/ai/topic-score", authed(token, {
      method: "POST", body: JSON.stringify({ topicId: topic.id }),
    }))).json()) as any;
    expect(res.status).toBe("queued");
    await drainAiRuns(deps);
    const done = await (await app.request(`/api/ai/runs/${res.id}`, authed(token))).json() as any;
    expect(done.status).toBe("done");
    const scored = await (await app.request("/api/topics", authed(token))).json() as any;
    res.topic = scored.items[0];
    expect(done.result.verdict).toBe("做");
    // 加权校验：80/10*25 + 90/10*20 + 60/10*15 + 50/10*15 + 70/10*10 + 80/10*8 + 90/10*7 = 20+18+9+7.5+7+6.4+6.3=74.2 → 74
    expect(res.topic.score).toBe(74);
    expect(res.topic.scoreDetail.fit).toBe(9);
  });
});

describe("归因任务管道（readback / metrics / account_snapshot）", () => {
  /** 建号 → 采集 → 草稿 → 发布 done；返回上下文供归因断言。 */
  async function publishDone(app: any, token: string, title = "原始标题") {
    await app.request("/api/ext/accounts/heartbeat", authed(token, {
      method: "POST",
      body: JSON.stringify({ accounts: [{ xhsUserId: "u1", nickname: "薯", subType: "creator", status: "online" }] }),
    }));
    await app.request("/api/ext/collect", authed(token, {
      method: "POST",
      body: JSON.stringify({ items: [{ noteId: "n1", title, author: {}, cover: "https://cdn/c.jpg" }] }),
    }));
    const accounts = (await (await app.request("/api/accounts", authed(token))).json()) as any;
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;
    const draft = (await (await app.request("/api/drafts", authed(token, {
      method: "POST", body: JSON.stringify({ collectedNoteId: notes.items[0].id }),
    }))).json()) as any;
    const job = (await (await app.request("/api/publish/jobs", authed(token, {
      method: "POST", body: JSON.stringify({ draftId: draft.id, accountId: accounts[0].id }),
    }))).json()) as any;
    await claimBrowser(app, token, "publish", job.id, "sw");
    await reportBrowser(app, token, "publish", job.id, { status: "done" });
    return { job, accounts };
  }

  const pendingTasks = async (app: any, token: string) =>
    ((await (await app.request("/api/ext/tasks/pending", authed(token))).json()) as any).tasks as any[];
  const claimTask = (app: any, token: string, id: number) => claimBrowser(app, token, "tasks", id, "sw");
  const reportTask = (app: any, token: string, id: number, body: unknown) => reportBrowser(app, token, "tasks", id, body);

  it("发布 done → readback 到期 → verified 匹配 → metrics×3 排定 + 快照落库", async () => {
    const { app, db, deps } = await makeApp();
    const { token } = await registerUser(app);
    const t0 = Date.now();
    let fakeNow = t0;
    deps.now = () => new Date(fakeNow);

    const { job } = await publishDone(app, token);

    // t0：readback 未到期，但心跳排的 account_snapshot 到期
    let tasks = await pendingTasks(app, token);
    expect(tasks.map((t) => t.type)).toEqual(["account_snapshot"]);
    // 快照任务跑一轮 → 落 account_snapshots；20h 内不再重排
    await claimTask(app, token, tasks[0].id);
    await reportTask(app, token, tasks[0].id, {
      status: "done", data: { followers: 1234, likesTotal: 5678, notesCount: 9 },
    });
    const { accountSnapshots, noteMetrics } = await import("../src/db/schema");
    const snaps = await db.select().from(accountSnapshots);
    expect(snaps[0]?.followers).toBe(1234);

    // +11min：readback 到期
    fakeNow += 11 * 60_000;
    tasks = await pendingTasks(app, token);
    const rb = tasks.find((t) => t.type === "readback");
    expect(rb.payload.publishJobId).toBe(job.id);
    await claimTask(app, token, rb.id);
    // 重复认领 → 404
    expect((await claimTask(app, token, rb.id)).status).toBe(404);
    await reportTask(app, token, rb.id, {
      status: "done",
      data: { items: [{ noteId: "note-abc", title: "原始标题", publishTime: fakeNow, url: "https://www.xiaohongshu.com/explore/note-abc?xsec_token=tk" }] },
    });
    const jobs = (await (await app.request("/api/publish/jobs", authed(token))).json()) as any;
    expect(jobs[0].outcome).toBe("verified");
    expect(jobs[0].noteId).toBe("note-abc");
    expect(jobs[0].verifiedAt).toBeTruthy();

    // +1h：第一条 metrics 到期；回报明细 → note_metrics 落库
    fakeNow += 60 * 60_000;
    tasks = await pendingTasks(app, token);
    expect(tasks.filter((t) => t.type === "metrics")).toHaveLength(1); // 24h/7d 未到期
    const mt = tasks.find((t) => t.type === "metrics");
    await claimTask(app, token, mt.id);
    await reportTask(app, token, mt.id, {
      status: "done",
      data: { rows: [{ noteId: "note-abc", views: 3200, likes: 210, collects: 40, comments: 12, shares: 5 }] },
    });
    const rows = await db.select().from(noteMetrics);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.views).toBe(3200);
    expect(rows[0]?.noteId).toBe("note-abc");
    expect(rows[0]?.publishJobId).toBe(job.id);
  });

  it("unverified → 30min 复读重排；耗尽后 outcome=unverified", async () => {
    const { app, deps } = await makeApp();
    const { token } = await registerUser(app);
    let fakeNow = Date.now();
    deps.now = () => new Date(fakeNow);
    const { job } = await publishDone(app, token);
    const miss = { status: "done", data: { items: [{ noteId: "other", title: "不相关", publishTime: fakeNow }] } };

    for (let i = 0; i < 3; i++) {
      fakeNow += 31 * 60_000; // 首轮 +10min 到期，unverified 重排 +30min——都覆盖
      const rb = (await pendingTasks(app, token)).find((t) => t.type === "readback");
      expect(rb).toBeTruthy();
      await claimTask(app, token, rb.id);
      const res = (await (await reportTask(app, token, rb.id, miss)).json()) as any;
      expect(Boolean(res.rescheduled)).toBe(i < 2); // 前两次重排，第三次定档
    }
    const jobs = (await (await app.request("/api/publish/jobs", authed(token))).json()) as any;
    expect(jobs[0].outcome).toBe("unverified");
    expect(jobs[0].noteId).toBeNull();
  });

  it("readback failed → 重排 ≤3 次后 outcome=readback_error；stale running 回收", async () => {
    const { app, db, deps } = await makeApp();
    const { token, userId } = await registerUser(app);
    let fakeNow = Date.now();
    deps.now = () => new Date(fakeNow);
    await publishDone(app, token);

    for (let i = 0; i < 3; i++) {
      fakeNow += 11 * 60_000;
      const rb = (await pendingTasks(app, token)).find((t) => t.type === "readback");
      expect(rb).toBeTruthy();
      await claimTask(app, token, rb.id);
      await reportTask(app, token, rb.id, { status: "failed", error: "页签超时" });
    }
    const jobs = (await (await app.request("/api/publish/jobs", authed(token))).json()) as any;
    expect(jobs[0].outcome).toBe("readback_error");

    // legacy running 没有有效租约，回 pending 后必须重新认领新代次
    const { jobs: jobsTable } = await import("../src/db/schema");
    await db.insert(jobsTable).values({
      userId, type: "metrics", status: "running",
      payload: { publishJobId: 1, noteId: "x" },
      claimedBy: "dead-sw", claimedAt: new Date(fakeNow - 31 * 60_000),
    });
    const tasks = await pendingTasks(app, token);
    expect(tasks.some((t) => t.type === "metrics" && t.payload.noteId === "x")).toBe(true);
  });

  it("login_required 直接定档不重试", async () => {
    const { app, deps } = await makeApp();
    const { token } = await registerUser(app);
    let fakeNow = Date.now();
    deps.now = () => new Date(fakeNow);
    await publishDone(app, token);
    fakeNow += 11 * 60_000;
    const rb = (await pendingTasks(app, token)).find((t) => t.type === "readback");
    await claimTask(app, token, rb.id);
    await reportTask(app, token, rb.id, { status: "done", outcome: "login_required", data: { items: [] } });
    const jobs = (await (await app.request("/api/publish/jobs", authed(token))).json()) as any;
    expect(jobs[0].outcome).toBe("login_required");
    // 不再重排
    fakeNow += 40 * 60_000;
    expect((await pendingTasks(app, token)).some((t) => t.type === "readback")).toBe(false);
  });
});
