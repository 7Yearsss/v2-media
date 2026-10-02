import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { aiRuns, collectedNotes, hostedAccounts, topics } from "../src/db/schema";
import { runAiJobs } from "../src/lib/ai-runs";
import { createTopicAiRunHandlers } from "../src/lib/topic-ai-run";
import { authed, makeApp, registerUser } from "./helpers";

const detail = { traffic: 8, fit: 9, diff: 6, monetization: 5, evergreen: 7, cost: 8, risk: 9 };
const generated = JSON.stringify({ topics: [{ title: "冷冻备餐清单", angle: "从分区开始", reason: "样本#1点赞100", scoreDetail: detail }] });
const scored = JSON.stringify({ scoreDetail: detail, verdict: "做", advice: "先验证一个场景" });
async function fixture() {
  const complete = vi.fn(async () => generated);
  const f = await makeApp({ complete });
  const { token, userId } = await registerUser(f.app);
  const [account] = await f.db.insert(hostedAccounts).values({ userId, xhsUserId: "account", subType: "creator",
    nickname: "备餐号", positioning: "家庭备餐", styleNotes: "短句清单", redlines: "不编经历", personaVersion: 1 }).returning();
  const collection = await (await f.app.request("/api/collections", authed(token, { method: "POST", body: JSON.stringify({ name: "备餐" }) }))).json() as any;
  await f.app.request("/api/ext/collect", authed(token, { method: "POST", body: JSON.stringify({ collectionId: collection.id,
    items: [{ noteId: "sample", title: "旧样本", author: {}, cover: "", likes: 100 }],
    details: [{ noteId: "sample", title: "旧样本", content: "旧正文", images: [], tags: ["备餐"] }] }) }));
  const [note] = await f.db.select().from(collectedNotes).where(eq(collectedNotes.userId, userId));
  const generate = async (operationId = randomUUID(), extra: object = {}) => {
    const response = await f.app.request("/api/ai/topics", authed(token, { method: "POST", body: JSON.stringify({ collectionId: collection.id,
      accountId: account!.id, count: 1, operationId, ...extra }) }));
    return { status: response.status, run: await response.json() as any };
  };
  const createTopic = async () => await (await f.app.request("/api/topics", authed(token, { method: "POST", body: JSON.stringify({
    title: "早上备餐", angle: "从分区开始", collectionId: collection.id, sourceNoteId: note!.id, accountId: account!.id }) }))).json() as any;
  const score = async (topicId: number) => await (await f.app.request("/api/ai/topic-score", authed(token, {
    method: "POST", body: JSON.stringify({ topicId, operationId: randomUUID() }) }))).json() as any;
  const read = async (id: number) => (await (await f.app.request(`/api/ai/runs/${id}`, authed(token))).json()) as any;
  const worker = () => runAiJobs(f.deps, createTopicAiRunHandlers(f.deps));
  return { ...f, complete, token, userId, account: account!, collection, note: note!, generate, createTopic, score, read, worker };
}

describe("持久选题 AI 任务（内存 PGlite/mock AI）", () => {
  it("202不等待模型；重复操作返回同一任务；样本编辑后仍用冻结输入且入池一次", async () => {
    const f = await fixture(), operation = randomUUID();
    const first = await f.generate(operation);
    expect(first.status).toBe(202); expect(first.run.status).toBe("queued"); expect(f.complete).not.toHaveBeenCalled();
    await f.db.update(collectedNotes).set({ title: "新样本", content: "新正文", likes: 999 }).where(eq(collectedNotes.id, f.note.id));
    const replay = await f.generate(operation);
    expect(replay.run.id).toBe(first.run.id);
    expect((await f.generate(operation, { count: 2 })).status).toBe(409);
    await f.worker(); await f.worker();
    expect(f.complete).toHaveBeenCalledTimes(1);
    const call = f.complete.mock.calls[0] as unknown as [string, string, { model: string }];
    expect(call[1]).toContain("旧样本"); expect(call[1]).toContain("旧正文"); expect(call[1]).not.toContain("新样本");
    expect(call[1]).toContain("不编经历"); expect(call[2].model).toBe(first.run.model);
    const done = await f.read(first.run.id);
    expect(done).toMatchObject({ status: "done", attempt: 1, result: { count: 1 } });
    expect(done).not.toHaveProperty("frozenInput"); expect(done).not.toHaveProperty("leaseId");
    const rows = await f.db.select().from(topics).where(eq(topics.userId, f.userId));
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ score: 74, scoreModel: first.run.model });
  });

  it("重建依赖后从数据库恢复排队任务，不依赖HTTP请求闭包", async () => {
    const f = await fixture(), first = await f.generate();
    const restarted = { ...f.deps, ai: { complete: vi.fn(async () => generated) } };
    await runAiJobs(restarted, createTopicAiRunHandlers(restarted));
    expect((await f.read(first.run.id)).status).toBe("done");
    expect(f.complete).not.toHaveBeenCalled(); expect(restarted.ai.complete).toHaveBeenCalledTimes(1);
  });

  it("缺维度/空评分明细明确失败，整批不部分入池；手动重试复用原快照", async () => {
    const f = await fixture();
    f.complete.mockResolvedValueOnce(JSON.stringify({ topics: [JSON.parse(generated).topics[0], { title: "缺少七维" }] }));
    const created = await f.generate(randomUUID(), { count: 2 });
    await f.worker();
    expect(await f.read(created.run.id)).toMatchObject({ status: "failed", errorCode: "invalid_output", attempt: 1 });
    expect(await f.db.select().from(topics).where(eq(topics.userId, f.userId))).toHaveLength(0);
    await f.db.update(collectedNotes).set({ content: "改后的正文" }).where(eq(collectedNotes.id, f.note.id));
    const retry = await f.app.request(`/api/ai/runs/${created.run.id}/retry`, authed(f.token, { method: "POST", body: JSON.stringify({ operationId: randomUUID() }) }));
    expect(retry.status).toBe(202); await f.worker();
    const done = await f.read(created.run.id);
    expect(done).toMatchObject({ status: "done", attempt: 2, result: { count: 1 } });
    expect((f.complete.mock.calls[1] as unknown as [string, string])[1]).toContain("旧正文");
  });

  it("深评只写原选题版本；模型返回期间修改角度后旧结果取消", async () => {
    const f = await fixture(), topic = await f.createTopic();
    let release!: () => void, started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), beginning = new Promise<void>(resolve => { started = resolve; });
    f.complete.mockImplementationOnce(async () => { started(); await hold; return scored; });
    const run = await f.score(topic.id), worker = f.worker();
    await beginning;
    await f.app.request(`/api/topics/${topic.id}`, authed(f.token, { method: "PATCH", body: JSON.stringify({ angle: "新角度" }) }));
    release(); await worker;
    expect(await f.read(run.id)).toMatchObject({ status: "canceled", errorCode: "target_obsolete" });
    const [current] = await f.db.select().from(topics).where(eq(topics.id, topic.id));
    expect(current).toMatchObject({ angle: "新角度", score: null });
    expect((await f.app.request(`/api/ai/runs/${run.id}/retry`, authed(f.token, { method: "POST", body: JSON.stringify({ operationId: randomUUID() }) }))).status).toBe(409);
  });

  it("深评有效七维由服务端加权，缺明细不能生成50分", async () => {
    const f = await fixture(), topic = await f.createTopic();
    f.complete.mockResolvedValueOnce(scored);
    const first = await f.score(topic.id); await f.worker();
    expect(await f.read(first.id)).toMatchObject({ status: "done", result: { topicId: topic.id, score: 74, verdict: "做" } });
    f.complete.mockResolvedValueOnce(JSON.stringify({ scoreDetail: {}, verdict: "做", advice: "缺少评分" }));
    const second = await f.score(topic.id); await f.worker();
    expect(await f.read(second.id)).toMatchObject({ status: "failed", errorCode: "invalid_output" });
    const [current] = await f.db.select().from(topics).where(eq(topics.id, topic.id));
    expect(current!.score).toBe(74);
  });

  it("人设版本、账号归档恢复与来源移出均不能授权旧选题任务", async () => {
    const f = await fixture();
    const first = await f.generate();
    await f.app.request(`/api/accounts/${f.account.id}`, authed(f.token, { method: "PATCH", body: JSON.stringify({ version: 1, styleNotes: "新风格" }) }));
    await f.worker(); expect((await f.read(first.run.id)).status).toBe("canceled");
    const second = await f.generate();
    await f.app.request(`/api/accounts/${f.account.id}`, authed(f.token, { method: "DELETE" }));
    await f.app.request(`/api/accounts/${f.account.id}/restore`, authed(f.token, { method: "POST" }));
    await f.worker(); expect((await f.read(second.run.id)).status).toBe("canceled");
    const third = await f.generate();
    await f.db.update(collectedNotes).set({ collectionId: null }).where(eq(collectedNotes.id, f.note.id));
    await f.worker(); expect((await f.read(third.run.id)).status).toBe("canceled");
    expect(f.complete).not.toHaveBeenCalled();
  });

  it("取消后的迟到模型与批量插入失败均不留下部分选题", async () => {
    const f = await fixture();
    let release!: () => void, started!: () => void;
    const hold = new Promise<void>(resolve => { release = resolve; }), beginning = new Promise<void>(resolve => { started = resolve; });
    f.complete.mockImplementationOnce(async () => { started(); await hold; return generated; });
    const first = await f.generate(), worker = f.worker(); await beginning;
    expect((await f.app.request(`/api/ai/runs/${first.run.id}/cancel`, authed(f.token, { method: "POST" }))).status).toBe(200);
    release(); await worker; expect((await f.read(first.run.id)).status).toBe("canceled");
    await f.db.execute(sql`ALTER TABLE topics ADD CONSTRAINT reject_ai_topics CHECK (source_type <> 'ai')`);
    const second = await f.generate(); await f.worker();
    expect((await f.read(second.run.id)).status).not.toBe("done");
    expect(await f.db.select().from(topics).where(eq(topics.userId, f.userId))).toHaveLength(0);
    const [run] = await f.db.select().from(aiRuns).where(and(eq(aiRuns.id, second.run.id), eq(aiRuns.userId, f.userId)));
    expect(run!.result).toBeNull();
  });
});
