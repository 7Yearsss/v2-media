import { describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import type { Draft, HostedAccount } from "@v2media/shared";
import { hostedAccounts, jobs, topics } from "../src/db/schema";
import { runDraftJobs } from "../src/lib/draft-jobs";
import { personaForPrompt } from "../src/lib/account-persona";
import { migrate } from "../src/db/migrate";
import { authed, makeApp, registerUser } from "./helpers";

const details = { traffic: 8, fit: 8, diff: 7, monetization: 5, evergreen: 6, cost: 8, risk: 9 };
const report = JSON.stringify({
  summary: "用清单讲清楚准备顺序", findings: [{ claim: "先列清单", evidence: ["#1 点赞100"], boundary: "只有一篇样本", todo: "写准备清单", confidence: "low", refs: [1] }],
  needs: [], traps: [], ideas: [{ title: "今晚先准备哪一步", hook: "先分区", angle: "借清单结构", refs: [1] }],
});
async function fixture() {
  const complete = vi.fn(async (system: string, user: unknown) => {
    if (system.includes('只输出一个 JSON 对象：{"title"')) return JSON.stringify({ title: "准备不用赶", content: "先分区，再准备。", tags: ["生活"], cover: "先分区再准备" });
    if (system.includes("内容策划师")) return JSON.stringify({ topics: [{ title: "准备清单", angle: "先分区", scoreDetail: details, reason: "#1 点赞100" }] });
    if (system.includes("选题评审")) return JSON.stringify({ scoreDetail: details, verdict: "做", advice: "先分区" });
    if (system.includes("种草笔记")) return "标题：新的标题\n正文：保留真实内容。";
    if (system.includes("标题优化")) return "标题一\n标题二";
    if (system.includes("SEO")) return "生活,清单";
    if (system.includes("审稿人")) return report;
    return "1. 先列清单，#1 点赞100，但样本只有一篇。";
  });
  const ctx = await makeApp({ complete });
  ctx.deps.r2 = { head: async () => false, put: async () => {}, putStream: async () => {}, get: async () => null, list: async () => [], delete: async () => true };
  const { token, userId } = await registerUser(ctx.app);
  const heartbeat = (nickname = "备餐号") => ctx.app.request("/api/ext/accounts/heartbeat", authed(token, { method: "POST", body: JSON.stringify({
    accounts: [{ xhsUserId: "food", nickname, subType: "creator", status: "online" },
      { xhsUserId: "camp", nickname: "露营号", subType: "creator", status: "online" }],
  }) }));
  await heartbeat();
  const accounts = await (await ctx.app.request("/api/accounts", authed(token))).json() as HostedAccount[];
  const save = (a: HostedAccount, fields: Record<string, unknown>, auth = token) =>
    ctx.app.request("/api/accounts/" + a.id, authed(auth, { method: "PATCH", body: JSON.stringify({ version: a.personaVersion, ...fields }) }));
  const a = await (await save(accounts[0]!, { positioning: "家庭备餐", styleNotes: "短句、清单", redlines: "不编造体验" })).json() as HostedAccount;
  const b = await (await save(accounts[1]!, { positioning: "露营装备", styleNotes: "轻松、讲原理", redlines: "不承诺效果" })).json() as HostedAccount;
  const col = await (await ctx.app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "生活" }) }))).json() as any;
  await ctx.app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ collectionId: col.id,
    items: [{ noteId: "source", title: "准备清单", author: {}, cover: "", likes: 100 }],
    details: [{ noteId: "source", title: "准备清单", content: "先分区，再准备。", images: [], tags: ["生活"] }],
  }) }));
  const createTopic = async (accountId?: number) => await (await ctx.app.request("/api/topics", authed(token, { method: "POST", body: JSON.stringify({
    title: "准备清单", angle: "先分区", collectionId: col.id, accountId,
  }) }))).json() as any;
  const createDraft = async (accountId?: number) => await (await ctx.app.request("/api/drafts", authed(token, { method: "POST", body: JSON.stringify({
    title: "准备清单", content: "先分区，再准备。", accountId, images: [{ url: "https://example.test/image.png" }],
  }) }))).json() as Draft;
  return { ...ctx, token, userId, a, b, save, heartbeat, col, createTopic, createDraft, complete };
}
const textCalls = (complete: ReturnType<typeof vi.fn>) => complete.mock.calls.map((c: any[]) => String(c[1]));

describe("账号人设（内存 PGlite/mock AI，无外网）", () => {
  it("三个字段按账号保存，心跳不覆盖，版本/长度/越权与其他字段拒绝", async () => {
    const f = await fixture();
    await f.heartbeat("备餐号的新昵称");
    let accounts = await (await f.app.request("/api/accounts", authed(f.token))).json() as HostedAccount[];
    expect(accounts[0]).toMatchObject({ positioning: "家庭备餐", styleNotes: "短句、清单", redlines: "不编造体验", personaVersion: 1 });
    expect(accounts[0]!.nickname).toBe("备餐号的新昵称");
    expect((await (await f.save(f.a, { styleNotes: f.a.styleNotes })).json() as HostedAccount).personaVersion).toBe(1);
    expect((await f.save({ ...f.a, personaVersion: 0 }, { styleNotes: "旧版本" })).status).toBe(409);
    expect((await f.save(f.a, { status: "online" })).status).toBe(400);
    expect((await f.save(f.a, { positioning: "字".repeat(1001) })).status).toBe(400);
    const { token: other } = await registerUser(f.app, "other@test.co");
    expect((await f.save(f.a, { redlines: "" }, other)).status).toBe(404);
    expect((await f.save(f.a, { redlines: "" })).status).toBe(200);
    accounts = await (await f.app.request("/api/accounts", authed(f.token))).json() as HostedAccount[];
    expect(accounts[0]!.redlines).toBe(""); expect(accounts[1]!.redlines).toBe("不承诺效果");
  });

  it("选题与深评分分别注入目标账号，快照记录当前规则", async () => {
    const f = await fixture();
    for (const a of [f.a, f.b]) {
      const res = await f.app.request("/api/ai/topics", authed(f.token, { method: "POST", body: JSON.stringify({ collectionId: f.col.id, count: 1, accountId: a.id }) }));
      expect(res.status).toBe(201);
      const topic = (await res.json() as any).items[0];
      expect(topic.personaSnapshot).toMatchObject({ accountId: a.id, styleNotes: a.styleNotes, redlines: a.redlines });
      const scored = await f.app.request("/api/ai/topic-score", authed(f.token, { method: "POST", body: JSON.stringify({ topicId: topic.id }) }));
      expect(scored.status).toBe(200);
    }
    const calls = textCalls(f.complete);
    expect(calls[0]).toContain("家庭备餐"); expect(calls[0]).toContain("短句、清单"); expect(calls[0]).not.toContain("露营装备");
    expect(calls[2]).toContain("露营装备"); expect(calls[2]).toContain("不承诺效果"); expect(calls[2]).not.toContain("家庭备餐");
    expect(calls[1]).toContain("不编造体验");
  });

  it("成稿冻结点击时的人设；一次性定位只改定位，风格与红线保留", async () => {
    const f = await fixture();
    const topic = await f.createTopic(f.a.id);
    const response = await f.app.request("/api/topics/" + topic.id + "/to-draft", authed(f.token, { method: "POST", body: JSON.stringify({
      ai: true, positioning: "本次写厨房整理",
    }) }));
    expect(response.status).toBe(202);
    const id = (await response.json() as any).draft.id;
    await f.save(f.a, { positioning: "改后的定位", styleNotes: "改后的风格", redlines: "改后的红线" });
    await runDraftJobs(f.deps);
    const draft = await (await f.app.request("/api/drafts/" + id, authed(f.token))).json() as Draft;
    expect(draft.personaSnapshot).toMatchObject({ accountId: f.a.id, version: 1, positioning: "本次写厨房整理", styleNotes: "短句、清单", redlines: "不编造体验" });
    const call = textCalls(f.complete)[0]!;
    expect(call).toContain("本次写厨房整理"); expect(call).toContain("不编造体验"); expect(call).not.toContain("改后的风格");
  });

  it("改写/标题/标签读取草稿当前账号，原始编辑文字不能绕过草稿归属", async () => {
    const f = await fixture();
    const draft = await f.createDraft(f.a.id);
    await f.app.request("/api/ai/rewrite", authed(f.token, { method: "POST", body: JSON.stringify({ draftId: draft.id, title: "正在编辑的标题", content: "正在编辑的正文" }) }));
    expect(textCalls(f.complete)[0]).toContain("家庭备餐");
    await f.app.request("/api/drafts/" + draft.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ accountId: f.b.id }) }));
    for (const route of ["rewrite", "titles", "tags"]) {
      const result = await f.app.request("/api/ai/" + route, authed(f.token, { method: "POST", body: JSON.stringify({ draftId: draft.id, title: "当前标题", content: "当前正文", count: 2 }) }));
      expect(result.status).toBe(200);
    }
    expect(textCalls(f.complete).slice(1).every(t => t.includes("露营装备") && t.includes("不承诺效果") && !t.includes("家庭备餐"))).toBe(true);
    expect((await f.app.request("/api/ai/rewrite", authed(f.token, { method: "POST", body: JSON.stringify({ draftId: draft.id, accountId: null }) }))).status).toBe(200);
    expect(textCalls(f.complete).at(-1)).not.toContain("目标账号");
    const { token: other } = await registerUser(f.app, "rewrite-other@test.co");
    const prior = f.complete.mock.calls.length;
    expect((await f.app.request("/api/ai/rewrite", authed(other, { method: "POST", body: JSON.stringify({ draftId: draft.id, title: "伪装标题", content: "伪装正文" }) }))).status).toBe(404);
    expect((await f.app.request("/api/ai/rewrite", authed(other, { method: "POST", body: JSON.stringify({ title: "标题", accountId: f.a.id }) }))).status).toBe(404);
    expect(f.complete).toHaveBeenCalledTimes(prior);
  });

  it("分析的两步提示与历史报告保存原快照，换人设不改旧报告", async () => {
    const f = await fixture();
    const res = await f.app.request("/api/collections/" + f.col.id + "/analyze", authed(f.token, { method: "POST", body: JSON.stringify({ accountId: f.a.id, positioning: "本次收纳" }) }));
    expect(res.status).toBe(202);
    let row = await res.json() as any;
    await f.save(f.a, { styleNotes: "新风格" });
    for (let i = 0; i < 80 && row.status === "running"; i++) {
      await new Promise(r => setTimeout(r, 25));
      row = await (await f.app.request("/api/collections/" + f.col.id + "/analyses/" + row.id, authed(f.token))).json();
    }
    expect(row.status).toBe("done");
    expect(row.data.persona).toMatchObject({ version: 1, positioning: "本次收纳", styleNotes: "短句、清单", redlines: "不编造体验" });
    const calls = textCalls(f.complete);
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.every(t => t.includes("本次收纳") && t.includes("不编造体验") && !t.includes("新风格"))).toBe(true);
  });

  it("发布前拒绝过期人设版本，用实际目标账号冻结规则，后续编辑不改任务", async () => {
    const f = await fixture();
    const draft = await f.createDraft(f.a.id);
    const updated = await (await f.save(f.b, { redlines: "新的露营红线" })).json() as HostedAccount;
    const create = (version: number) => f.app.request("/api/publish/jobs", authed(f.token, { method: "POST", body: JSON.stringify({
      draftId: draft.id, accountId: f.b.id, personaVersion: version, visibility: "private",
    }) }));
    expect((await create(1)).status).toBe(409);
    const response = await create(updated.personaVersion);
    expect(response.status).toBe(200);
    const job = await response.json() as any;
    expect(job.personaSnapshot).toMatchObject({ accountId: f.b.id, redlines: "新的露营红线", positioning: "露营装备" });
    await f.save(updated, { redlines: "再改的红线" });
    const list = await (await f.app.request("/api/publish/jobs", authed(f.token))).json() as any[];
    expect(list[0].personaSnapshot.redlines).toBe("新的露营红线");
  });

  it("AI 正在评分时更换目标账号，旧结果不回写；通用上下文兼容", async () => {
    const f = await fixture();
    const topic = await f.createTopic(f.a.id);
    let release!: () => void, started!: () => void;
    const hold = new Promise<void>(r => { release = r; }), begin = new Promise<void>(r => { started = r; });
    f.complete.mockImplementationOnce(async () => { started(); await hold; return JSON.stringify({ scoreDetail: details, verdict: "做", advice: "先分区" }); });
    const pending = f.app.request("/api/ai/topic-score", authed(f.token, { method: "POST", body: JSON.stringify({ topicId: topic.id }) }));
    await begin;
    await f.app.request("/api/topics/" + topic.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ accountId: f.b.id }) }));
    release(); expect((await pending).status).toBe(409);
    const [current] = await f.db.select().from(topics).where(eq(topics.id, topic.id));
    expect(current!.score).toBeNull();
    expect(personaForPrompt(null)).toBe("");
    const raw = await f.app.request("/api/ai/rewrite", authed(f.token, { method: "POST", body: JSON.stringify({ title: "标题", content: "正文" }) }));
    expect(raw.status).toBe(200);
    expect(textCalls(f.complete).at(-1)).not.toContain("目标账号");
  });

  it("成稿过程中换账号保留手稿，重试使用新账号的人设", async () => {
    const f = await fixture();
    const topic = await f.createTopic(f.a.id);
    const created = await (await f.app.request("/api/topics/" + topic.id + "/to-draft", authed(f.token, { method: "POST", body: JSON.stringify({ ai: true }) }))).json() as any;
    await f.app.request("/api/drafts/" + created.draft.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ accountId: f.b.id }) }));
    await runDraftJobs(f.deps);
    const draft = await (await f.app.request("/api/drafts/" + created.draft.id, authed(f.token))).json() as Draft;
    expect(draft.generationState).toBe("failed"); expect(f.complete).not.toHaveBeenCalled();
    expect((await f.app.request("/api/drafts/" + draft.id + "/generate/retry", authed(f.token, { method: "POST" }))).status).toBe(202);
    await runDraftJobs(f.deps);
    expect(textCalls(f.complete)[0]).toContain("露营装备"); expect(textCalls(f.complete)[0]).not.toContain("家庭备餐");
    const [job] = await f.db.select().from(jobs).where(eq(jobs.type, "draft_generate"));
    expect(job).toBeTruthy();
  });

  it("旧草稿首次迁移继承关联选题账号，之后清空账号不会被重启回填", async () => {
    const f = await fixture();
    const draft = await f.createDraft();
    const topic = await f.createTopic(f.a.id);
    await f.db.update(topics).set({ draftId: draft.id }).where(eq(topics.id, topic.id));
    await f.db.execute(sql`ALTER TABLE drafts DROP COLUMN account_id`);
    await migrate(f.db);
    let current = await (await f.app.request("/api/drafts/" + draft.id, authed(f.token))).json() as Draft;
    expect(current.accountId).toBe(f.a.id);
    await f.app.request("/api/drafts/" + draft.id, authed(f.token, { method: "PATCH", body: JSON.stringify({ accountId: null }) }));
    await migrate(f.db);
    current = await (await f.app.request("/api/drafts/" + draft.id, authed(f.token))).json() as Draft;
    expect(current.accountId).toBeNull();
  });
});
