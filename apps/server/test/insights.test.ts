import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { makeApp, authed, claimBrowser, registerUser, reportBrowser } from "./helpers";
import { randomUUID } from "node:crypto";
import { BROWSER_EXECUTION_CAPABILITY as capability } from "@v2media/shared";
import { accountSnapshots, drafts, hostedAccounts, jobs, noteMetrics, postmortemReports, publishJobs, topics } from "../src/db/schema";
import { runPostmortemJobs } from "../src/lib/postmortem-jobs";
import type { AiClient } from "../src/modules/ai";

const at = new Date("2026-10-01T00:00:00Z"), HOUR = 3_600_000;
async function fixture(ai?: AiClient) {
  const { app, db, deps } = await makeApp(ai);
  const { token, userId } = await registerUser(app);
  deps.now = () => new Date(at.getTime() + 30 * HOUR);
  const [account] = await db.insert(hostedAccounts).values({ userId, nickname: "备餐号", xhsUserId: "one", redlines: "不编造经历" }).returning();
  const [draft] = await db.insert(drafts).values({ userId, title: "先备好这几样", content: "真实备餐步骤", accountId: account!.id, images: [{ url: "https://example.com/owned.png" }] }).returning();
  const [topic] = await db.insert(topics).values({ userId, title: draft!.title, draftId: draft!.id, accountId: account!.id, score: 70,
    scoreDetail: { traffic: 7, fit: 8 }, scoreMethod: "seven-dim-v1", scoreModel: "mock-v1", scoredAt: at }).returning();
  const request = (url: string, body?: unknown, method = body === undefined ? "GET" : "POST") => app.request(url, authed(token, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const create = async (visibility = "public", noteId = "n1") => {
    const res = await request("/api/publish/jobs", { draftId: draft!.id, accountId: account!.id, visibility });
    expect(res.status).toBe(200); const j = await res.json() as any;
    await db.update(publishJobs).set({ status: "done", outcome: "verified", noteId, publishedAt: at, verifiedAt: at, createdAt: at }).where(eq(publishJobs.id, j.id));
    return j.id as number;
  };
  const metric = async (jobId: number, hours: number, likes: number | null, values: Record<string, number | null> = {}, noteId = "n1") => {
    const [m] = await db.insert(noteMetrics).values({ userId, publishJobId: jobId, noteId, capturedAt: new Date(at.getTime() + hours * HOUR),
      likes, collects: 0, comments: 0, shares: 0, ...values }).returning(); return m!;
  };
  return { app, db, deps, token, userId, account: account!, draft: draft!, topic: topic!, request, create, metric };
}

describe("数据洞察和复盘（内存 PGlite/mock AI）", () => {
  it("每篇只取最新快照，0 与缺失分开，私密默认排除，重复笔记和错误关联不加总", async () => {
    const f = await fixture(), id = await f.create();
    await f.metric(id, 1, 10, { views: 100 }); await f.metric(id, 25, 20);
    await f.metric(id, 26, 900, {}, "other-note");
    const duplicate = await f.create("public", "n1"); await f.metric(duplicate, 25, 500);
    const privateId = await f.create("private", "private"); await f.metric(privateId, 25, 0, {}, "private");
    const second = await f.create("public", "n2"); await f.metric(second, 25, null, { views: 0 }, "n2");
    const o = await (await f.request("/api/insights/overview")).json() as any;
    expect(o.notesCount).toBe(2); expect(o.excludedPrivate).toBe(1); expect(o.excludedDuplicate).toBe(1);
    expect(o.totals.likes).toBe(20); expect(o.coverage.likes).toBe(1); expect(o.totals.views).toBe(0); expect(o.coverage.views).toBe(1);
    expect(o.totals.exposure).toBeNull(); expect(o.coverage.exposure).toBe(0);
    const list = await (await f.request("/api/insights/notes?includePrivate=1")).json() as any;
    expect(list.items.find((n: any) => n.publishJobId === privateId).metric.interactions).toBe(0);
    expect(list.items.find((n: any) => n.publishJobId === second).metric.interactions).toBeNull();
  });
  it("按实际发布时间选窗口，晚到样本不冒充 1 小时；同账号/口径/模型分组，历史缺失不校准", async () => {
    const f = await fixture(), id = await f.create();
    await f.metric(id, 3, 99); await f.metric(id, 25, 20, { views: 100 }); await f.metric(id, 27, 50, { views: 500 });
    const before = await (await f.request("/api/insights/overview?horizon=1h")).json() as any;
    expect(before.sampledCount).toBe(0); expect(before.calibration.eligibleCount).toBe(0);
    const o = await (await f.request("/api/insights/overview?horizon=24h")).json() as any;
    expect(o.totals.likes).toBe(20); expect(o.calibration.groups[0]).toMatchObject({ count: 1, medianInteractions: 20, medianViews: 100, medianExposure: null, minAgeMs: 25 * HOUR });
    const old = await f.create("public", "old"); await f.metric(old, 25, 30, {}, "old");
    await f.db.update(publishJobs).set({ publishedAt: null, planningSnapshot: null }).where(eq(publishJobs.id, old));
    const filtered = await (await f.request("/api/insights/overview?horizon=24h")).json() as any;
    expect(filtered.calibration.eligibleCount).toBe(1); expect(filtered.calibration.exclusions["实际发布时间缺失"]).toBe(1);
    const d = await (await f.request(`/api/insights/notes/${old}`)).json() as any;
    expect(d.evidence.metrics[0].ageMs).toBeNull(); expect(d.evidence.gaps.join(" ")).toContain("平台实际发布时间未采到");
  });
  it("用户隔离、账号/日期校验和账号趋势按实采范围；列表不泄漏原始 extra", async () => {
    const f = await fixture(), id = await f.create(); await f.metric(id, 25, 0);
    const other = await registerUser(f.app, "other@b.co");
    expect((await f.app.request(`/api/insights/notes/${id}`, authed(other.token))).status).toBe(404);
    expect((await f.app.request(`/api/insights/overview?accountId=${f.account.id}`, authed(other.token))).status).toBe(404);
    expect((await f.request("/api/insights/overview?from=5&to=3")).status).toBe(400);
    expect((await f.request("/api/insights/notes?offset=-1")).status).toBe(400);
    await f.db.insert(accountSnapshots).values([{ userId: f.userId, accountId: f.account.id, capturedAt: at, followers: 0 },
      { userId: f.userId, accountId: f.account.id, capturedAt: new Date(at.getTime() + HOUR), followers: 10 }]);
    const o = await (await f.request(`/api/insights/overview?from=${at.getTime()}&to=${at.getTime() + HOUR}`)).json() as any;
    expect(o.accounts[0].points.map((p: any) => p.followers)).toEqual([0, 10]); expect(o.accounts[0].points[0].likesTotal).toBeNull();
    await f.db.update(noteMetrics).set({ extra: { source: "unknown", xsecToken: "never_expose", noteUrl: "token_url" } }).where(eq(noteMetrics.publishJobId, id));
    const text = await (await f.request(`/api/insights/notes/${id}`)).text(); expect(text).not.toContain("never_expose"); expect(text).not.toContain("token_url");
  });
  it("发布时冻结评分/封面，重复发布分别关联同一选题；后改人设/正文/评分不改变历史", async () => {
    const f = await fixture();
    await f.db.update(drafts).set({ coverSpec: { templateVersion: 1, templateId: "poster", headline: "备餐" } }).where(eq(drafts.id, f.draft.id));
    const id = await f.create(), id2 = await f.create("public", "n2");
    await f.request(`/api/topics/${f.topic.id}`, { title: "新方向" }, "PATCH");
    await f.db.update(drafts).set({ content: "后来修改" }).where(eq(drafts.id, f.draft.id));
    const d = await (await f.request(`/api/insights/notes/${id}`)).json() as any;
    expect(d.note.planning).toMatchObject({ topicId: f.topic.id, score: 70, scoreModel: "mock-v1" });
    expect(d.evidence.content.content).toBe("真实备餐步骤"); expect(d.evidence.cover.headline).toBe("备餐");
    const d2 = await (await f.request(`/api/insights/notes/${id2}`)).json() as any; expect(d2.note.planning.topicId).toBe(f.topic.id);
    const [topic] = await f.db.select().from(topics).where(eq(topics.id, f.topic.id)); expect(topic!.score).toBeNull(); expect(topic!.scoreModel).toBeNull();
  });
  it("复盘立即 202、并发幂等、持久快照/引用；新回采与正文修改不改旧报告，刷新建新历史", async () => {
    let calls = 0, prompt = "";
    const f = await fixture({ complete: async (_system, user) => { calls++; prompt = String(user); const input = JSON.parse(prompt), id = input.metrics[0].id;
      return JSON.stringify({ evidence: [{ metricIds: [id], observation: "这次回采互动为零" }], hypotheses: [], experiments: [{ change: "下一篇试一个标题", observe: "同窗口真实互动" }] }); } });
    const id = await f.create(), m = await f.metric(id, 25, 0);
    const responses = await Promise.all([f.request("/api/ai/postmortem", { publishJobId: id }), f.request("/api/ai/postmortem", { publishJobId: id })]);
    expect(responses.map(r => r.status)).toEqual([202, 202]); const reports = await Promise.all(responses.map(r => r.json())) as any[];
    expect(reports[0].id).toBe(reports[1].id); expect(calls).toBe(0);
    await f.metric(id, 27, 100); await f.db.update(drafts).set({ content: "后来稿" }).where(eq(drafts.id, f.draft.id));
    await runPostmortemJobs(f.deps);
    expect(calls).toBe(1); expect(prompt).toContain("真实备餐步骤"); expect(prompt).not.toContain("后来稿");
    const detail = await (await f.request(`/api/insights/notes/${id}`)).json() as any;
    expect(detail.reports[0].status).toBe("done"); expect(detail.reports[0].evidence.metrics).toHaveLength(1); expect(detail.reports[0].insight.evidence[0].metricIds).toEqual([m.id]);
    expect((await f.request("/api/ai/postmortem", { publishJobId: id })).status).toBe(200);
    const fresh = await (await f.request("/api/ai/postmortem", { publishJobId: id, refresh: true })).json() as any;
    expect(fresh.id).not.toBe(reports[0].id); expect(fresh.evidence.metrics).toHaveLength(2);
    const other = await registerUser(f.app, "other@b.co"); expect((await f.app.request("/api/ai/postmortem", authed(other.token, { method: "POST", body: JSON.stringify({ publishJobId: id }) }))).status).toBe(404);
    const pending = await (await f.request("/api/ext/tasks/pending")).json() as any; expect(pending.tasks.some((t: any) => t.type === "postmortem")).toBe(false);
    const [job] = await f.db.select().from(jobs).where(eq(jobs.type, "postmortem")); expect((await f.request(`/api/ext/tasks/${job!.id}/result`, { capability, claimedBy: "sw-test", leaseId: randomUUID(), attempt: 1, receiptId: randomUUID(), status: "done" })).status).toBe(400);
  });
  it("无回采/私密/旧原文不足时不让模型编结论；坏引用失败可重试", async () => {
    let calls = 0; const f = await fixture({ complete: async () => { calls++; return JSON.stringify({ evidence: [{ metricIds: [999999], observation: "坏依据" }], hypotheses: [], experiments: [{ change: "x", observe: "y" }] }); } });
    const privateId = await f.create("private", "private"); await f.metric(privateId, 25, 0, {}, "private");
    await f.request("/api/ai/postmortem", { publishJobId: privateId }); await runPostmortemJobs(f.deps); expect(calls).toBe(0);
    const d = await (await f.request(`/api/insights/notes/${privateId}`)).json() as any; expect(d.reports[0].insight.evidence).toEqual([]); expect(d.reports[0].evidence.gaps.join(" ")).toContain("非公开");
    const id = await f.create(); await f.metric(id, 25, 0);
    await f.request("/api/ai/postmortem", { publishJobId: id }); await runPostmortemJobs(f.deps);
    const bad = await (await f.request(`/api/insights/notes/${id}`)).json() as any;
    expect(bad.reports[0].status).toBe("failed"); expect(bad.reports[0].error).toContain("不存在");
    expect((await f.request("/api/ai/postmortem", { publishJobId: id })).status).toBe(202);
  });
  it("遗留 running/claim 中断被回收，迟到模型不能覆写失败报告", async () => {
    let release!: () => void; const gate = new Promise<void>(r => release = r);
    const f = await fixture({ complete: async (_s, u) => { await gate; const id = JSON.parse(String(u)).metrics[0].id;
      return JSON.stringify({ evidence: [{ metricIds: [id], observation: "观察" }], hypotheses: [], experiments: [{ change: "x", observe: "y" }] }); } });
    const id = await f.create(); await f.metric(id, 25, 0); await f.request("/api/ai/postmortem", { publishJobId: id });
    const running = runPostmortemJobs(f.deps);
    // Wait for the model gate without racing the persisted state.
    for (let i = 0; i < 100; i++) { const [r] = await f.db.select().from(postmortemReports); if (r?.status === "running") break; await new Promise(r => setTimeout(r, 5)); }
    f.deps.now = () => new Date(at.getTime() + 31 * HOUR); await runPostmortemJobs(f.deps);
    release(); await running;
    const [report] = await f.db.select().from(postmortemReports); expect(report!.status).toBe("failed"); expect(report!.insight).toBeNull();
    const response = await (await f.request("/api/ai/postmortem", { publishJobId: id })).json() as any;
    const [queued] = await f.db.select().from(jobs).where(and(eq(jobs.type, "postmortem"), eq(jobs.status, "queued")));
    await f.db.update(jobs).set({ status: "processing", claimedAt: at }).where(eq(jobs.id, queued!.id));
    await runPostmortemJobs(f.deps); const [reaped] = await f.db.select().from(postmortemReports).where(eq(postmortemReports.id, response.id)); expect(reaped!.status).toBe("failed");
  });
  it("读回记录平台时间、指标保留排期与实采时刻，非有限/负值缺失而不是零", async () => {
    const f = await fixture(), id = await f.create();
    const [task] = await f.db.insert(jobs).values({ userId: f.userId, type: "readback", payload: { publishJobId: id, title: f.draft.title, publishedAt: at.getTime(), xhsUserId: "one" } }).returning();
    await f.db.update(publishJobs).set({ outcome: null, verifiedAt: null, publishedAt: null }).where(eq(publishJobs.id, id));
    await claimBrowser(f.app, f.token, "tasks", task!.id);
    await reportBrowser(f.app, f.token, "tasks", task!.id, { status: "done", data: { items: [{ noteId: "n1", title: f.draft.title, publishTime: at.getTime(), url: "https://example.com/n1" }] } });
    const [pj] = await f.db.select().from(publishJobs).where(eq(publishJobs.id, id)); expect(pj!.publishedAt?.toISOString()).toBe(at.toISOString());
    const [metricsTask] = await f.db.insert(jobs).values({ userId: f.userId, type: "metrics", dueAt: at, payload: { publishJobId: id, noteId: "n1" } }).returning();
    await claimBrowser(f.app, f.token, "tasks", metricsTask!.id);
    await reportBrowser(f.app, f.token, "tasks", metricsTask!.id, { status: "done", data: { rows: [{ noteId: "n1", likes: -1, views: 0, comments: 2 }] } });
    const [m] = await f.db.select().from(noteMetrics).where(eq(noteMetrics.publishJobId, id)); expect(m!.likes).toBeNull(); expect(m!.views).toBe(0); expect(m!.capturedAt.toISOString()).toBe(f.deps.now().toISOString()); expect(m!.extra?.scheduledFor).toBe(at.toISOString());
  });
});
