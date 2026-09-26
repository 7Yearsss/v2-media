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

  it("collection analyze: AI 报告落库 + 越权 404 + 空库 400", async () => {
    const { app } = await makeApp();
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
    const ana = (await (await app.request(`/api/collections/${col.id}/analyze`, authed(token, { method: "POST" }))).json()) as any;
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

  it("评论落库后，无评论的详情重传不清空 commentsData", async () => {
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
      commentsData: [{ commentId: "k1", userName: "薯友", content: "求链接", likes: 9 }],
    }]);
    await collect([{ noteId: "c1", title: "带评论", author: {}, cover: "c" }]);
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;
    expect(notes.items).toHaveLength(1);
    expect(notes.items[0].commentsData?.[0]?.content).toBe("求链接");
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

describe("topics 选题池", () => {
  it("CRUD + plannedAt 驱动状态流转 + 越权 404", async () => {
    const { app } = await makeApp();
    const { token } = await registerUser(app);
    const t = (await (await app.request("/api/topics", authed(token, {
      method: "POST", body: JSON.stringify({ title: "露营装备清单" }),
    }))).json()) as any;
    expect(t.status).toBe("idea");
    expect(t.sourceType).toBe("manual");
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
    await app.request(`/api/ext/publish/${job.id}/claim`, authed(token, {
      method: "POST", body: JSON.stringify({ claimedBy: "sw-test" }),
    }));
    await app.request(`/api/ext/publish/${job.id}/result`, authed(token, {
      method: "POST", body: JSON.stringify({ status: "done", resultUrl: "https://xhs/x" }),
    }));
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
            { title: "极简版" }, // 维度缺失 → 兜底 5 分
          ],
        }),
    };
    const { app } = await makeApp(ai);
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
    expect(res.items).toHaveLength(2);
    expect(res.items[0].score).toBe(100);
    expect(res.items[0].sourceType).toBe("ai");
    expect(res.items[0].collectionId).toBe(col.id);
    expect(res.items[0].angle).toContain("推荐理由");
    expect(res.items[1].score).toBe(50); // 全维度兜底 5 → 50
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
    const { app } = await makeApp(ai);
    const { token } = await registerUser(app);
    const topic = (await (await app.request("/api/topics", authed(token, {
      method: "POST", body: JSON.stringify({ title: "早八穿搭" }),
    }))).json()) as any;
    const res = (await (await app.request("/api/ai/topic-score", authed(token, {
      method: "POST", body: JSON.stringify({ topicId: topic.id }),
    }))).json()) as any;
    expect(res.verdict).toBe("做");
    // 加权校验：80/10*25 + 90/10*20 + 60/10*15 + 50/10*15 + 70/10*10 + 80/10*8 + 90/10*7 = 20+18+9+7.5+7+6.4+6.3=74.2 → 74
    expect(res.topic.score).toBe(74);
    expect(res.topic.scoreDetail.fit).toBe(9);
  });
});
