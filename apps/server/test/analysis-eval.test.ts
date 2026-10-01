import { describe, expect, it } from "vitest";

import { gradeInsight } from "../src/lib/analysis-grader";
import { computeSignals, type SignalNote } from "../src/lib/analysis-signals";
import { parseInsight } from "../src/lib/insight-parse";

/**
 * 分析评测（不连外网）：
 * 1. 信号层 —— 合成一个埋了规律的库，代码必须把规律算出来（这是 AI 解读的地基）
 * 2. 评分器 —— 好报告过、各种失败模式被抓（作为提示词改动的回归底线）
 *
 * 想对真实模型跑：把 deps.ai 换成真实客户端，对 fixture 调 /analyze，再把 data.insight 喂给 gradeInsight，
 * 失败项就是下一步该补进提示词的内容（只为失败加内容）。
 */

const NOW = new Date("2026-06-01T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function note(ref: number, o: Partial<SignalNote>): SignalNote {
  return {
    ref,
    title: `普通笔记${ref}`,
    type: "image",
    authorName: `作者${ref}`,
    likes: 100,
    collects: 20,
    comments: 5,
    shares: 1,
    tags: [],
    content: "",
    hasDetail: true,
    publishedAt: day(30),
    commentsData: [],
    ...o,
  };
}

/** 埋点：数字标题 + 收藏型是爆款；一篇 3 年老帖；同一作者占 3 个爆款；视频更强；评论里有人求链接。 */
function fixture(): SignalNote[] {
  const hits = [
    note(1, { title: "3个技巧让你效率翻倍", likes: 9000, collects: 7000, comments: 300, authorName: "大号" }),
    note(2, { title: "5步搞定整理，新手必看", likes: 8000, collects: 6000, comments: 200, authorName: "大号" }),
    note(3, { title: "10个APP清单", likes: 7000, collects: 5000, comments: 100, authorName: "大号" }),
    note(4, { title: "别再这样做了", likes: 6000, collects: 800, comments: 900, type: "video" }),
    note(5, { title: "三年前的老帖", likes: 20000, collects: 9000, comments: 500, publishedAt: day(1200) }),
  ];
  const rest = Array.from({ length: 15 }, (_, i) =>
    note(6 + i, { title: `日常记录${"甲乙丙丁戊己庚辛壬癸子丑寅卯辰"[i]}`, likes: 100 + i * 5, collects: 10, comments: 3 }),
  );
  hits[0]!.commentsData = [
    { content: "求链接！在哪里买", likes: 80 },
    { content: "我之前用过，亲测有效", likes: 30 },
    { content: "太真实了哈哈", likes: 12 },
    { content: "是不是智商税啊", likes: 9 },
    { content: "这个教程能出详细版吗", likes: 5 },
  ];
  return [...hits, ...rest];
}

describe("分析信号层（埋点必须被算出来）", () => {
  const s = computeSignals(fixture(), NOW);

  it("样本与爆款划分", () => {
    expect(s.sample.total).toBe(20);
    expect(s.sample.hit).toBe(5); // top 25%
    expect(s.sample.videos).toBe(1);
  });

  it("数字钩子在爆款里占比高、有正向增益", () => {
    const num = s.hooks.find((h) => h.key === "number")!;
    expect(num.hitShare).toBeGreaterThanOrEqual(60);
    expect(num.lift).toBeGreaterThan(5);
  });

  it("爆款藏赞比明显高于其余", () => {
    const t = s.traits.find((x) => x.key === "saveRate")!;
    expect(t.hit).toBeGreaterThan(t.rest * 3);
  });

  it("笔记类型：收藏型被识别", () => {
    expect(s.points.find((p) => p.ref === 1)!.kind).toBe("tool");
  });

  it("评论归类覆盖求资源/质疑/经验/共鸣", () => {
    const keys = s.comments!.categories.map((c) => c.key);
    expect(keys).toEqual(expect.arrayContaining(["ask", "doubt", "exp", "like"]));
  });

  it("不可复制：老帖 + 作者扎堆 被点名", () => {
    const reasons = s.traps.map((t) => t.reason);
    expect(reasons).toContain("old");
    expect(reasons).toContain("author");
  });

  it("样本太小时不瞎下结论（lift=null、无评论分类）", () => {
    const tiny = computeSignals([note(1, {}), note(2, {})], NOW);
    expect(tiny.comments).toBeNull();
    expect(tiny.hooks.every((h) => h.lift === null)).toBe(true);
  });
});

const ctx = {
  titles: fixture().map((n) => n.title),
  comments: fixture().flatMap((n) => (n.commentsData as { content: string }[]).map((c) => c.content)),
};
const refs = (...ids: number[]) => ids.map((id) => ({ id, title: `t${id}` }));

describe("报告评分器", () => {
  const good = {
    summary: "收藏理由 > 情绪，清单型标题吃红利",
    findings: [
      { claim: "清单+数字标题拿收藏", evidence: ["藏赞比 0.8 vs 0.1", "#1 #2 #3"], boundary: "对纯情绪内容不成立", todo: "标题先放数字再放收益", confidence: "high" as const, refs: refs(1, 2, 3) },
      { claim: "争议类靠评论区带量", evidence: ["#4 评论 900"], boundary: "话题敏感度高时有风险", todo: "开头抛反常识观点", confidence: "mid" as const, refs: refs(4) },
    ],
    needs: [{ need: "想要购买入口", quote: "求链接！在哪里买", refs: refs(1) }],
    traps: [{ title: "三年前的老帖", reason: "靠三年积累" }],
    ideas: [
      { title: "4个习惯让你告别拖延", hook: "拖延不是懒，是你没拆任务", angle: "借 #1 的数字清单结构", refs: refs(1) },
      { title: "7步整理桌面，新手也能做", hook: "先清空，再分区", angle: "借 #2 步骤式", refs: refs(2) },
      { title: "别再乱买收纳盒了", hook: "我踩过的坑你别再踩", angle: "借 #4 的反差", refs: refs(4) },
    ],
  };

  it("好报告满分", () => {
    const r = gradeInsight(good, ctx);
    expect(r.failures).toEqual([]);
    expect(r.score).toBe(100);
  });

  it("抓：形容词式空话（没法照做）", () => {
    const vague = { ...good, findings: [{ ...good.findings[0]!, claim: "增强用户代入感", todo: "提升内容吸引力" }, good.findings[1]!] };
    expect(gradeInsight(vague, ctx).failures.join("\n")).toContain("形容词式空话");
  });

  it("抓：编造评论 / 照搬原标题 / 无证据 / 超长 / 数据复述 / 解析失败", () => {
    const bad = {
      ...good,
      summary: "9000 7000 300 1",
      findings: [{ ...good.findings[0]!, evidence: [], boundary: "" }, { ...good.findings[1]!, claim: "这是一条特别特别特别特别特别特别特别特别特别特别长的判断句子" }],
      needs: [{ need: "想要折扣", quote: "能不能给我打个五折优惠", refs: [] }],
      ideas: [{ title: "10个APP清单", hook: "", angle: "x", refs: [] }, ...good.ideas.slice(0, 2)],
    };
    const f = gradeInsight(bad, ctx).failures.join("\n");
    expect(f).toContain("数据复述");
    expect(f).toContain("没有证据");
    expect(f).toContain("没写不成立的条件");
    expect(f).toContain("超长");
    expect(f).toContain("找不到");
    expect(f).toContain("照搬");
    expect(gradeInsight(null, ctx).score).toBe(0);
  });
});

describe("parseInsight", () => {
  it("映射 refs、丢掉无效编号、钳制 confidence", () => {
    const byRef = new Map([[1, { id: 11, title: "A" }]]);
    const out = parseInsight(
      JSON.stringify({
        summary: "结论",
        findings: [{ claim: "c", evidence: ["e"], boundary: "b", todo: "t", confidence: "weird", refs: ["#1", "#99"] }],
        ideas: [{ title: "标题", hook: "h", angle: "a", refs: [1] }],
      }),
      (r) => byRef.get(Number(String(r).replace(/\D/g, ""))) ?? null,
    )!;
    expect(out.findings![0]!.confidence).toBe("mid");
    expect(out.findings![0]!.refs).toEqual([{ id: 11, title: "A" }]);
    expect(out.ideas![0]!.refs).toEqual([{ id: 11, title: "A" }]);
  });

  it("非报告 JSON → null", () => {
    expect(parseInsight('{"error":"x"}')).toBeNull();
    expect(parseInsight("没有 json")).toBeNull();
  });
});

describe("异步分析", () => {
  it("AI 失败 → 行标 failed 并带原因；running 超时被回收", async () => {
    const { makeApp, registerUser, authed } = await import("./helpers");
    const { app, db } = await makeApp({
      complete: async () => {
        throw new Error("gateway 524");
      },
    });
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "x" }) }))).json()) as any;
    await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ collectionId: col.id, items: [{ noteId: "n1", title: "t", author: {}, cover: "", likes: 5 }] }) }));
    const run = (await (await app.request(`/api/collections/${col.id}/analyze`, authed(token, { method: "POST" }))).json()) as any;
    let row: any = run;
    for (let i = 0; i < 100 && row.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 50));
      row = (await (await app.request(`/api/collections/${col.id}/analyses/${run.id}`, authed(token))).json()) as any;
    }
    expect(row.status).toBe("failed");
    expect(row.error).toContain("524");

    // 模拟进程重启遗留的 running 行：超过阈值后读取时被回收
    const { sql } = await import("drizzle-orm");
    await db.execute(sql`update collection_analyses set status='running', error=null, created_at = now() - interval '30 minutes'`);
    const reaped = (await (await app.request(`/api/collections/${col.id}/analyses/${run.id}`, authed(token))).json()) as any;
    expect(reaped.status).toBe("failed");
    expect(reaped.error).toContain("中断");
  });
});

describe("对照组", () => {
  it("同类一火一不火成对，互动差距不够大的不配", async () => {
    const { contrastPairs } = await import("../src/lib/analysis-run");
    const mk = (id: number, title: string, tags: string[], likes: number) =>
      ({ id, ref: id, noteId: String(id), type: "image", title, cover: "", likes, collects: 0, comments: 0, shares: 0, tags, content: "", hasDetail: true, publishedAt: null, sourceKeyword: "", commentsData: [] }) as any;
    const pool = [
      mk(1, "新手臀腿跟练", ["健身", "臀腿"], 9000),
      mk(2, "胸肌训练计划", ["健身", "胸"], 8000),
      mk(3, "臀腿训练日常", ["健身", "臀腿"], 100), // 与 1 同类、差距大 → 配对
      mk(4, "胸肌日常打卡", ["健身", "胸"], 7000), // 与 2 同类但差距小 → 不配
      mk(5, "今天吃什么", ["美食"], 50),
    ];
    const pairs = contrastPairs(pool, 2);
    expect(pairs.map((p) => [p.hit.id, p.low.id])).toEqual([[1, 3]]);
  });
});

describe("模型输出里抠 JSON", () => {
  it("草稿 + 说明 + 终稿：取最后一个能用的；字符串里的括号不乱配", () => {
    const draft = JSON.stringify({ summary: "草稿" });
    const final = JSON.stringify({ summary: "终稿 {含括号}", findings: [{ claim: "c", evidence: ["e"], boundary: "b", todo: "t" }] });
    const text = `想想…\n\`\`\`json\n${draft}\n\`\`\`\n再改改：\n${final}\n以上。`;
    expect(parseInsight(text)!.summary).toBe("终稿 {含括号}");
  });
});

describe("违禁词检测", () => {
  it("命中极限用语/功效/导流/承诺/诱导，普通表达不误伤", async () => {
    const { checkBannedWords } = await import("@v2media/shared");
    const hit = (t: string) => checkBannedWords(t).map((h) => h.kind);
    expect(hit("这是全网最低价，顶级好用")).toContain("extreme");
    expect(hit("7天瘦10斤，根治")).toContain("medical");
    expect(hit("加我微信 13812345678")).toContain("contact");
    expect(hit("保证月入过万")).toContain("promise");
    expect(hit("求赞求关注")).toContain("bait");
    // “最后问你一遍”“第一次练臀腿”里的“最/第一”不能误伤（只匹配“最好/最低…”和“第一”整词的限定见规则）
    expect(hit("最后问你一遍 那个前刺你删不删")).toEqual([]);
    expect(hit("今天练背，感觉不错")).toEqual([]);
  });
});

describe("选题成稿", () => {
  it("AI 成稿：不拷贝来源图、命中违禁词会重写一次、选题标记为 drafted", async () => {
    const { makeApp, registerUser, authed } = await import("./helpers");
    let calls = 0;
    const { app } = await makeApp({
      complete: async () => {
        calls++;
        const bad = calls === 1;
        return JSON.stringify({ title: "新手练臀腿", content: bad ? "这是最好的方法，加我微信" : "按这个顺序练：先激活再主项", tags: ["健身", "#臀腿"], cover: "新手臀腿" });
      },
    });
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "x" }) }))).json()) as any;
    await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ collectionId: col.id, items: [{ noteId: "n1", title: "原笔记", author: {}, cover: "http://x/a.jpg", likes: 9 }] }) }));
    const notes = (await (await app.request("/api/notes", authed(token))).json()) as any;
    const noteId = (notes.items ?? notes)[0].id;
    const topic = (await (await app.request("/api/topics", authed(token, { method: "POST", body: JSON.stringify({ title: "选题A", angle: "钩子一句\n借鉴思路", sourceNoteId: noteId }) }))).json()) as any;
    const res = await app.request(`/api/topics/${topic.id}/to-draft`, authed(token, { method: "POST", body: JSON.stringify({ ai: true, positioning: "健身" }) }));
    expect(res.status).toBe(201);
    const r = (await res.json()) as any;
    expect(calls).toBe(2); // 第一版命中违禁词 → 重写一次
    expect(r.draft.content).toBe("按这个顺序练：先激活再主项");
    expect(r.draft.images).toEqual([]);
    expect(r.draft.tags).toEqual(["健身", "臀腿"]);
    expect(r.coverText).toBe("新手臀腿");
    expect(r.warnings).toEqual([]);
    expect(r.topic.status).toBe("drafted");
  });
});

describe("分析进度", () => {
  it("生成中能读到当前阶段；完成后进度移除", async () => {
    const { makeApp, registerUser, authed } = await import("./helpers");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const { app } = await makeApp({
      complete: async () => {
        calls++;
        if (calls === 1) await gate; // 卡在第一次 AI 调用（提假设）
        return calls === 1 ? "假设" : JSON.stringify({ summary: "结论", findings: [{ claim: "c", evidence: ["e"], boundary: "b", todo: "t" }] });
      },
    });
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "x" }) }))).json()) as any;
    await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ collectionId: col.id, items: [{ noteId: "n1", title: "t", author: {}, cover: "", likes: 5 }] }) }));
    const run = (await (await app.request(`/api/collections/${col.id}/analyze`, authed(token, { method: "POST" }))).json()) as any;
    const get = async () => (await (await app.request(`/api/collections/${col.id}/analyses/${run.id}`, authed(token))).json()) as any;

    let row: any = run;
    for (let i = 0; i < 100 && row.data?.progress?.stage !== "hypotheses"; i++) {
      await new Promise((r) => setTimeout(r, 30));
      row = await get();
    }
    expect(row.status).toBe("running");
    expect(row.data.progress.stage).toBe("hypotheses");
    expect(row.data.progress.steps).toEqual(["signals", "covers", "hypotheses", "report"]);

    release();
    for (let i = 0; i < 100 && row.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 30));
      row = await get();
    }
    expect(row.status).toBe("done");
    expect(row.data.progress).toBeUndefined();
  });
});

describe("输出质量把关", () => {
  const good = { summary: "给动作组数的跟练清单最易被收藏", findings: [
    { claim: "封面打出动作名和组数", evidence: ["e"], boundary: "b", todo: "t", confidence: "high" },
    { claim: "标题点名新手人群", evidence: ["e"], boundary: "b", todo: "t", confidence: "mid" },
  ] };
  const junk = { summary: "Analyzing data to structure the JSON response effectively.", findings: [{ claim: "Calculate popularity", evidence: ["x"], boundary: "b", todo: "t" }] };

  it("英文草稿不合格；中文终稿合格", async () => {
    const { isUsableInsight } = await import("../src/lib/insight-parse");
    expect(isUsableInsight(parseInsight(JSON.stringify(junk)))).toBe(false);
    expect(isUsableInsight(parseInsight(JSON.stringify(good)))).toBe(true);
    expect(isUsableInsight(null)).toBe(false);
  });

  it("多个对象时优先选合格的：英文草稿在后也不会被选中", () => {
    const text = `${JSON.stringify(good)}\n\n再想想：\n${JSON.stringify(junk)}`;
    expect(parseInsight(text)!.summary).toBe(good.summary);
  });

  it("流水线：第一次终稿不合格 → 重写一次并采用合格的", async () => {
    const { makeApp, registerUser, authed } = await import("./helpers");
    let reports = 0;
    const { app } = await makeApp({
      complete: async (system) => {
        if (!system.includes("审稿人")) return "假设";
        reports++;
        return JSON.stringify(reports === 1 ? junk : good);
      },
    });
    const { token } = await registerUser(app);
    const col = (await (await app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "x" }) }))).json()) as any;
    await app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ collectionId: col.id, items: [{ noteId: "n1", title: "t", author: {}, cover: "", likes: 5 }] }) }));
    const run = (await (await app.request(`/api/collections/${col.id}/analyze`, authed(token, { method: "POST" }))).json()) as any;
    let row: any = run;
    for (let i = 0; i < 100 && row.status === "running"; i++) {
      await new Promise((r) => setTimeout(r, 30));
      row = (await (await app.request(`/api/collections/${col.id}/analyses/${run.id}`, authed(token))).json()) as any;
    }
    expect(reports).toBe(2);
    expect(row.data.insight.summary).toBe(good.summary);
  });
});
