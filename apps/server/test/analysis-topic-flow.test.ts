import { describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { CollectionAnalysis, HostedAccount, Topic } from "@v2media/shared";
import { topicFromAnalysis } from "../../web/src/lib/analysis-topic-flow";
import { collectedNotes, collectionAnalyses, drafts, jobs, topics } from "../src/db/schema";
import { runDraftJobs } from "../src/lib/draft-jobs";
import { authed, makeApp, registerUser } from "./helpers";

const insight = JSON.stringify({
  summary: "先列准备清单", findings: [{ claim: "分区准备", evidence: ["#1 点赞100"], boundary: "只有一篇样本", todo: "列准备清单", confidence: "low", refs: [1] }],
  needs: [], traps: [], ideas: [{ title: "准备清单怎么分区", hook: "先区分用途", angle: "借清单结构，不编造使用体验", refs: [1] }],
});

async function fixture() {
  const complete = vi.fn(async (system: string, _user: unknown) => {
    if (system.includes('只输出一个 JSON 对象：{"title"')) return JSON.stringify({
      title: "准备顺序记下来", content: "先分区，再按用途列清单。", tags: ["准备清单"], cover: "先分区再准备",
    });
    return system.includes("审稿人") ? insight : "1. 先列清单，#1 点赞100，样本只有一篇。";
  });
  const f = await makeApp({ complete });
  f.deps.r2 = { head: async () => false, put: async () => {}, putStream: async () => {}, get: async () => null, list: async () => [], delete: async () => true };
  const { token, userId } = await registerUser(f.app);
  const request = (path: string, body?: unknown, method = "POST") => f.app.request(path, authed(token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  await request("/api/ext/accounts/heartbeat", { accounts: [
    { xhsUserId: "food", nickname: "备餐号", subType: "creator", status: "online" },
    { xhsUserId: "camp", nickname: "露营号", subType: "creator", status: "online" },
  ] });
  const accounts = await (await f.app.request("/api/accounts", authed(token))).json() as HostedAccount[];
  const update = async (account: HostedAccount, fields: Record<string, unknown>) => {
    const response = await request(`/api/accounts/${account.id}`, { version: account.personaVersion, ...fields }, "PATCH");
    expect(response.status).toBe(200); return await response.json() as HostedAccount;
  };
  const a = await update(accounts[0]!, { positioning: "家庭备餐", styleNotes: "短句清单", redlines: "不编造体验" });
  const b = await update(accounts[1]!, { positioning: "露营装备", styleNotes: "轻松讲原理", redlines: "不承诺效果" });
  const col = await (await request("/api/collections", { name: "准备清单库" })).json() as { id: number };
  await request("/api/ext/collect", { collectionId: col.id,
    items: [{ noteId: "source", title: "原始准备清单", author: {}, cover: "", likes: 100 }],
    details: [{ noteId: "source", title: "原始准备清单", content: "原作者先分区，再准备。", images: [], tags: ["生活"] }],
  });
  const analyze = async (account?: HostedAccount, positioning?: string) => {
    const response = await request(`/api/collections/${col.id}/analyze`, { accountId: account?.id, positioning });
    expect(response.status).toBe(202);
    let report = await response.json() as CollectionAnalysis;
    for (let i = 0; i < 80 && report.status === "running"; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      report = await (await f.app.request(`/api/collections/${col.id}/analyses/${report.id}`, authed(token))).json() as CollectionAnalysis;
    }
    expect(report.status).toBe("done"); return report;
  };
  const create = async (report: CollectionAnalysis) => {
    const response = await request("/api/topics", topicFromAnalysis(report, 0));
    expect(response.status).toBe(201); return await response.json() as Topic;
  };
  const toDraft = (topic: Topic) => request(`/api/topics/${topic.id}/to-draft`, { ai: true });
  return { ...f, token, userId, request, update, a, b, col, analyze, create, toDraft, complete };
}

describe("分析建议 → 选题 → 异步成稿（实际 API/内存 PGlite/mock AI）", () => {
  it("两个账号保留报告来源与定位，成稿冻结当前风格/红线，历史报告不改写", async () => {
    const f = await fixture();
    for (const [account, override] of [[f.a, "本次厨房收纳"], [f.b, "本次露营打包"]] as const) {
      const report = await f.analyze(account, override);
      const payload = topicFromAnalysis(report, 0);
      expect(payload).toMatchObject({ accountId: account.id, analysisId: report.id, analysisIdeaIndex: 0, collectionId: f.col.id });
      const topic = await f.create(report);
      expect(topic).toMatchObject({ accountId: account.id, analysisSource: {
        analysisId: report.id, ideaIndex: 0, positioning: override, persona: { accountId: account.id, version: 1, styleNotes: account.styleNotes, redlines: account.redlines },
      } });
      const current = await f.update(account, { styleNotes: account.styleNotes + "（当前规则）", redlines: account.redlines + "（当前规则）" });
      const queued = await f.toDraft(topic);
      expect(queued.status).toBe(202);
      const queuedBody = await queued.json() as any;
      const draftId = queuedBody.draft.id;
      await f.update(current, { styleNotes: "排队后再次修改", redlines: "排队后再次修改" });
      await runDraftJobs(f.deps);
      const [draft] = await f.db.select().from(drafts).where(eq(drafts.id, draftId));
      expect(draft).toMatchObject({ accountId: account.id, generationState: "done", personaSnapshot: {
        accountId: account.id, version: 2, positioning: override, styleNotes: current.styleNotes, redlines: current.redlines,
      } });
      const [job] = await f.db.select().from(jobs).where(eq(jobs.id, queuedBody.jobId));
      expect((job!.payload as any).analysisSource).toEqual(topic.analysisSource);
      const [historical] = await f.db.select().from(collectionAnalyses).where(eq(collectionAnalyses.id, report.id));
      expect(historical!.data.persona).toEqual(report.data.persona);
    }
    const inputs = f.complete.mock.calls.filter(c => c[0].includes('只输出一个 JSON 对象：{"title"')).map(c => String(c[1]));
    expect(inputs).toHaveLength(2);
    expect(inputs[0]).toContain("本次厨房收纳"); expect(inputs[0]).toContain("短句清单（当前规则）"); expect(inputs[0]).toContain("不编造体验（当前规则）");
    expect(inputs[1]).toContain("本次露营打包"); expect(inputs[1]).toContain("轻松讲原理（当前规则）"); expect(inputs[1]).toContain("不承诺效果（当前规则）");
    expect(inputs.every(input => input.includes("原作者先分区") && !input.includes("排队后再次修改"))).toBe(true);
    expect(inputs[0]).not.toContain("露营装备"); expect(inputs[1]).not.toContain("家庭备餐");
  });

  it("入池后明确换账号不继承旧定位，明确清空现存账号才使用通用风格", async () => {
    const f = await fixture();
    const report = await f.analyze(f.a, "只属于备餐号的定位");
    const topic = await f.create(report);
    expect((await f.request(`/api/topics/${topic.id}`, { accountId: 0 }, "PATCH")).status).toBe(400);
    expect((await f.request(`/api/topics/${topic.id}`, { accountId: f.b.id }, "PATCH")).status).toBe(200);
    expect((await f.toDraft(topic)).status).toBe(202);
    await runDraftJobs(f.deps);
    const generic = await f.create(report);
    expect((await f.request(`/api/topics/${generic.id}`, { accountId: null }, "PATCH")).status).toBe(200);
    expect((await f.toDraft(generic)).status).toBe(202);
    await runDraftJobs(f.deps);
    const inputs = f.complete.mock.calls.filter(c => c[0].includes('只输出一个 JSON 对象：{"title"')).map(c => String(c[1]));
    expect(inputs[0]).toContain("露营装备"); expect(inputs[0]).toContain("轻松讲原理"); expect(inputs[0]).toContain("不承诺效果");
    expect(inputs[0]).not.toContain("只属于备餐号的定位"); expect(inputs[0]).not.toContain("不编造体验");
    expect(inputs[1]).not.toContain("目标账号"); expect(inputs[1]).not.toContain("只属于备餐号的定位");
  });

  it("报告/库/建议/笔记/目标账号不匹配与越权均拒绝，不能伪造来源快照", async () => {
    const f = await fixture();
    const report = await f.analyze(f.a);
    const payload = topicFromAnalysis(report, 0);
    const before = await f.db.select().from(topics);
    for (const change of [{ accountId: f.b.id }, { collectionId: f.col.id + 999 }, { analysisIdeaIndex: 99 },
      { title: "另一个标题" }, { sourceNoteId: payload.sourceNoteId! + 999 }]) {
      expect((await f.request("/api/topics", { ...payload, ...change })).status).toBe(409);
    }
    expect((await f.request("/api/topics", { ...payload, analysisIdeaIndex: undefined })).status).toBe(400);
    const { token: other } = await registerUser(f.app, "other-analysis@test.co");
    expect((await f.app.request("/api/topics", authed(other, { method: "POST", body: JSON.stringify(payload) }))).status).toBe(404);
    await f.db.update(collectionAnalyses).set({ status: "running" }).where(eq(collectionAnalyses.id, report.id));
    expect((await f.request("/api/topics", payload)).status).toBe(409);
    expect(await f.db.select().from(topics)).toEqual(before);
    expect(await f.db.select().from(jobs).where(eq(jobs.type, "draft_generate"))).toHaveLength(0);
    await f.db.update(collectionAnalyses).set({ status: "done" }).where(eq(collectionAnalyses.id, report.id));
    const accepted = await f.request("/api/topics", { ...payload, accountId: undefined,
      analysisSource: { analysisId: 999, persona: { accountId: f.b.id, redlines: "伪造快照" } } });
    expect(accepted.status).toBe(201);
    expect(await accepted.json()).toMatchObject({ accountId: f.a.id, analysisSource: {
      analysisId: report.id, persona: { accountId: f.a.id, redlines: f.a.redlines },
    } });
  });

  it("目标账号解绑、报告删除或来源笔记移动后转稿会明确失败，保留选题不创建半成品", async () => {
    const f = await fixture();
    const report = await f.analyze(f.a);
    const topic = await f.create(report);
    expect((await f.request(`/api/accounts/${f.a.id}`, undefined, "DELETE")).status).toBe(200);
    expect((await f.toDraft(topic)).status).toBe(409);
    expect((await f.request("/api/topics", topicFromAnalysis(report, 0))).status).toBe(404);
    expect((await f.request(`/api/topics/${topic.id}`, { accountId: f.b.id }, "PATCH")).status).toBe(200);
    await f.db.update(collectedNotes).set({ collectionId: null }).where(eq(collectedNotes.id, topic.sourceNoteId!));
    expect((await f.toDraft(topic)).status).toBe(409);
    await f.db.delete(collectionAnalyses).where(eq(collectionAnalyses.id, report.id));
    expect((await f.toDraft(topic)).status).toBe(404);
    expect(await f.db.select().from(drafts)).toHaveLength(0);
    expect(await f.db.select().from(jobs).where(eq(jobs.type, "draft_generate"))).toHaveLength(0);
  });

  it("无账号的来源定位可贯穿选题池转稿，未完成报告不会在前端成为可执行建议", async () => {
    const f = await fixture();
    const report = await f.analyze(undefined, "这次只写准备清单");
    expect(() => topicFromAnalysis({ ...report, status: "running" }, 0)).toThrow("尚未完成");
    expect(() => topicFromAnalysis(report, 10)).toThrow("已变化");
    const topic = await f.create(report);
    expect((await f.toDraft(topic)).status).toBe(202);
    await runDraftJobs(f.deps);
    const [draft] = await f.db.select().from(drafts);
    expect(draft!.personaSnapshot).toMatchObject({ accountId: null, positioning: "这次只写准备清单", styleNotes: "", redlines: "" });
    expect(f.complete.mock.calls.filter(c => c[0].includes('只输出一个 JSON 对象：{"title"'))[0]![1]).toContain("这次只写准备清单");
  });
});
