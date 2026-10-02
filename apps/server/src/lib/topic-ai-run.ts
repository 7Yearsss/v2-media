import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { AccountPersonaSnapshot, AiTopicsRequest, AiTopicScoreRequest } from "@v2media/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { collectedNotes, collections, hostedAccounts, topics } from "../db/schema";
import { env } from "../env";
import { personaForPrompt, resolveAccountPersona } from "./account-persona";
import { AiRunError, aiRunView, enqueueAiRun, findAiRunOperation, type AiRunHandlers, type AiRunRow } from "./ai-runs";
import { assertWritable } from "./runtime-policy";

export const TOPIC_SCORE_METHOD = "seven-dim-v1:25/20/15/15/10/8/7";
const weights = { traffic: 25, fit: 20, diff: 15, monetization: 15, evergreen: 10, cost: 8, risk: 7 } as const;
const dimension = z.number().finite().min(1).max(10);
const detailSchema = z.object({ traffic: dimension, fit: dimension, diff: dimension, monetization: dimension,
  evergreen: dimension, cost: dimension, risk: dimension });
const suggestionSchema = z.object({ title: z.string().trim().min(1).max(512), angle: z.string().trim().max(4000).default(""),
  reason: z.string().trim().max(500).default(""), scoreDetail: detailSchema });
const generationSchema = z.object({ topics: z.array(suggestionSchema).min(1).max(10) });
const scoreSchema = z.object({ scoreDetail: detailSchema, verdict: z.enum(["做", "改方向", "不做"]), advice: z.string().trim().min(1).max(4000) });
type Suggestion = z.infer<typeof suggestionSchema>;
type Score = z.infer<typeof scoreSchema>;

const generationSystem = "你是小红书内容策划师。输入是采集库里的笔记列表（标题/互动/标签/正文节选）。" +
  "根据这些样本提炼选题方向，沿同赛道换角度，不照抄标题，不把样本互动当作新选题表现保证。" +
  "每个选题按七维打1-10分：traffic流量潜力、fit账号匹配、diff竞争差异、monetization变现潜力、evergreen时效价值、cost制作成本(越高越省事)、risk合规风险(越高越安全)。" +
  '只输出JSON对象：{"topics":[{"title":"选题标题","angle":"切入角度与要点","scoreDetail":{"traffic":8,"fit":7,"diff":6,"monetization":5,"evergreen":6,"cost":8,"risk":9},"reason":"推荐理由，引用样本ID及其已给出的数据"}]}';
const scoreSystem = "你是小红书选题评审。对选题按traffic/fit/diff/monetization/evergreen/cost/risk各打1-10分。" +
  "cost越高越省事，risk越高越安全。遵循账号人设；缺少表现证据时评分是预测，不能当成已验证结论。" +
  '只输出JSON：{"scoreDetail":{"traffic":8,"fit":7,"diff":6,"monetization":5,"evergreen":6,"cost":8,"risk":9},"verdict":"做|改方向|不做","advice":"具体建议"}';

interface BaseInput {
  system: string;
  user: string;
  persona: AccountPersonaSnapshot | null;
  accountExecutionRevision: number | null;
}
interface NoteSample { id: number; title: string; likes: number; collects: number; comments: number; shares: number; tags: string[]; excerpt: string }
interface GenerationInput extends BaseInput { collectionId: number; collectionName: string; count: number; samples: NoteSample[] }
interface TopicSnapshot { id: number; title: string; angle: string; status: string; accountId: number | null;
  collectionId: number | null; sourceNoteId: number | null; sourceType: string; updatedAtToken: string }
interface ScoreInput extends BaseInput { topic: TopicSnapshot }

function sameTopic(current: TopicSnapshot, original: TopicSnapshot) {
  return (Object.keys(current) as Array<keyof TopicSnapshot>).every(key => current[key] === original[key]);
}

const topicSelect = { id: topics.id, title: topics.title, angle: topics.angle, status: topics.status, accountId: topics.accountId,
  collectionId: topics.collectionId, sourceNoteId: topics.sourceNoteId, sourceType: topics.sourceType,
  updatedAtToken: sql<string>`${topics.updatedAt}::text` };

function parse<T>(raw: string, schema: z.ZodType<T>): T {
  let data: unknown;
  try {
    const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    data = JSON.parse(text);
  } catch { throw new AiRunError("invalid_output", "AI 返回的选题评分格式无效，未写入选题或评分"); }
  const value = schema.safeParse(data);
  if (!value.success) throw new AiRunError("invalid_output", "AI 未返回完整有效的七维评分，未写入选题或评分");
  return value.data;
}

function weightedScore(detail: z.infer<typeof detailSchema>) {
  return Math.round(Object.entries(weights).reduce((sum, [key, weight]) => sum + detail[key as keyof typeof weights] / 10 * weight, 0));
}

async function loadPersona(db: Db, userId: number, accountId?: number | null): Promise<
  { persona: AccountPersonaSnapshot | null; accountExecutionRevision: number | null } | { error: string; code: 404 | 409 }> {
  if (accountId) await db.execute(sql`SELECT id FROM hosted_accounts WHERE id=${accountId} AND user_id=${userId} FOR SHARE`);
  const persona = await resolveAccountPersona(db, userId, accountId);
  if (persona.error) return { error: persona.error, code: persona.code };
  const [account] = accountId ? await db.select({ executionRevision: hostedAccounts.executionRevision }).from(hostedAccounts)
    .where(and(eq(hostedAccounts.id, accountId), eq(hostedAccounts.userId, userId))) : [];
  return { persona: persona.snapshot ?? null, accountExecutionRevision: account?.executionRevision ?? null };
}

export async function createTopicGenerationRun(deps: Deps, userId: number, request: AiTopicsRequest & { count: number }) {
  assertWritable(deps);
  return deps.db.transaction(async tx => {
    const db = tx as unknown as Db;
    const replay = await findAiRunOperation(db, userId, request.operationId, "topic_generate", request);
    if (replay) return { run: aiRunView(replay) };
    await tx.execute(sql`SELECT id FROM collections WHERE id=${request.collectionId} AND user_id=${userId} FOR SHARE`);
    const [collection] = await tx.select().from(collections).where(and(eq(collections.id, request.collectionId), eq(collections.userId, userId)));
    if (!collection) return { error: "collection not found", code: 404 as const };
    const persona = await loadPersona(db, userId, request.accountId);
    if ("error" in persona) return persona;
    const notes = await tx.select({ id: collectedNotes.id, title: collectedNotes.title, likes: collectedNotes.likes,
      collects: collectedNotes.collects, comments: collectedNotes.comments, shares: collectedNotes.shares,
      tags: collectedNotes.tags, content: collectedNotes.content }).from(collectedNotes)
      .where(and(eq(collectedNotes.collectionId, collection.id), eq(collectedNotes.userId, userId)))
      .orderBy(desc(sql`${collectedNotes.likes}+${collectedNotes.collects}+${collectedNotes.comments}+${collectedNotes.shares}`), collectedNotes.id)
      .limit(30).for("share");
    if (!notes.length) return { error: "库里还没有笔记，先采集一些", code: 400 as const };
    const samples = notes.map(({ content, tags, ...note }) => ({ ...note, tags: tags.slice(0, 8), excerpt: content.slice(0, 200) }));
    const input: GenerationInput = { ...persona, system: generationSystem, collectionId: collection.id,
      collectionName: collection.name, count: request.count, samples,
      user: [personaForPrompt(persona.persona), `采集库「${collection.name}」互动量Top${samples.length}篇：\n${samples.map(note => JSON.stringify(note)).join("\n")}\n\n生成${request.count}个选题。`].filter(Boolean).join("\n\n") };
    const run = await enqueueAiRun(db, { userId, kind: "topic_generate", targetType: "collection", targetId: collection.id,
      operationId: request.operationId, request, input, model: env.aiModel, promptVersion: "topic-generate-v2", now: deps.now() });
    return { run: aiRunView(run) };
  });
}

export async function createTopicScoreRun(deps: Deps, userId: number, request: AiTopicScoreRequest) {
  assertWritable(deps);
  return deps.db.transaction(async tx => {
    const db = tx as unknown as Db;
    const replay = await findAiRunOperation(db, userId, request.operationId, "topic_score", request);
    if (replay) return { run: aiRunView(replay) };
    const [original] = await tx.select(topicSelect).from(topics).where(and(eq(topics.id, request.topicId), eq(topics.userId, userId)));
    if (!original) return { error: "not found", code: 404 as const };
    if (original.status === "archived") return { error: "选题已归档，请恢复后再评分", code: 409 as const };
    if (!await sourceExists(db, userId, original)) return { error: "选题来源已不存在，请重新选择来源", code: 409 as const };
    const persona = await loadPersona(db, userId, original.accountId);
    if ("error" in persona) return persona;
    const [current] = await tx.select(topicSelect).from(topics).where(and(eq(topics.id, original.id), eq(topics.userId, userId))).for("share");
    if (!current || !sameTopic(current, original)) return { error: "选题已变化，请重新评分", code: 409 as const };
    const input: ScoreInput = { ...persona, topic: current, system: scoreSystem,
      user: [personaForPrompt(persona.persona), `选题：${current.title}\n切入角度：${current.angle || "（未填）"}`].filter(Boolean).join("\n\n") };
    const run = await enqueueAiRun(db, { userId, kind: "topic_score", targetType: "topic", targetId: current.id,
      operationId: request.operationId, request, input, model: env.aiModel, promptVersion: "topic-score-v2", now: deps.now() });
    return { run: aiRunView(run) };
  });
}

async function sourceExists(db: Db, userId: number, source: { collectionId: number | null; sourceNoteId?: number | null }) {
  if (source.collectionId) {
    await db.execute(sql`SELECT id FROM collections WHERE id=${source.collectionId} AND user_id=${userId} FOR SHARE`);
    const [collection] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.id, source.collectionId), eq(collections.userId, userId)));
    if (!collection) return false;
  }
  if (source.sourceNoteId) {
    await db.execute(sql`SELECT id FROM collected_notes WHERE id=${source.sourceNoteId} AND user_id=${userId} FOR SHARE`);
    const [note] = await db.select({ collectionId: collectedNotes.collectionId }).from(collectedNotes)
      .where(and(eq(collectedNotes.id, source.sourceNoteId), eq(collectedNotes.userId, userId)));
    if (!note || (source.collectionId && note.collectionId !== source.collectionId)) return false;
  }
  return true;
}

async function personaCurrent(db: Db, run: AiRunRow, input: BaseInput) {
  if (!input.persona?.accountId) return true;
  await db.execute(sql`SELECT id FROM hosted_accounts WHERE id=${input.persona.accountId} AND user_id=${run.userId} FOR SHARE`);
  const [account] = await db.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, input.persona.accountId), eq(hostedAccounts.userId, run.userId)));
  return !!account && !account.archivedAt && account.personaVersion === input.persona.version
    && account.executionRevision === input.accountExecutionRevision;
}

async function generationCurrent(db: Db, run: AiRunRow) {
  const input = run.frozenInput as GenerationInput;
  if (!await sourceExists(db, run.userId, input) || !await personaCurrent(db, run, input)) return false;
  const notes = await db.select({ id: collectedNotes.id }).from(collectedNotes)
    .where(and(eq(collectedNotes.userId, run.userId), eq(collectedNotes.collectionId, input.collectionId), inArray(collectedNotes.id, input.samples.map(note => note.id)))).for("share");
  return notes.length === input.samples.length;
}

async function scoreCurrent(db: Db, run: AiRunRow) {
  const input = run.frozenInput as ScoreInput;
  if (!await sourceExists(db, run.userId, input.topic) || !await personaCurrent(db, run, input)) return false;
  const [current] = await db.select(topicSelect).from(topics)
    .where(and(eq(topics.id, input.topic.id), eq(topics.userId, run.userId))).for("update");
  return !!current && current.status !== "archived" && sameTopic(current, input.topic);
}

export function createTopicAiRunHandlers(deps: Deps): AiRunHandlers {
  return {
    topic_generate: {
      check: generationCurrent,
      retry: generationCurrent,
      execute: async (run, controls) => {
        const input = run.frozenInput as GenerationInput;
        await controls.progress("generating", ["已冻结采集样本与账号人设", "正在生成选题和七维评分"]);
        const result = parse(await deps.ai.complete(input.system, input.user, { model: run.model, json: true }), generationSchema);
        if (result.topics.length > input.count) throw new AiRunError("invalid_output", "AI 返回选题数量超过本次范围，未写入选题");
        return result.topics;
      },
      apply: async (db, run, result) => {
        if (!await generationCurrent(db, run)) return null;
        const input = run.frozenInput as GenerationInput;
        const rows = await db.insert(topics).values((result as Suggestion[]).map(suggestion => ({ userId: run.userId,
          title: suggestion.title, angle: suggestion.reason ? `${suggestion.angle}\n\n推荐理由：${suggestion.reason}`.trim() : suggestion.angle,
          sourceType: "ai", collectionId: input.collectionId, accountId: input.persona?.accountId ?? null, status: "idea",
          score: weightedScore(suggestion.scoreDetail), scoreDetail: suggestion.scoreDetail, scoreMethod: TOPIC_SCORE_METHOD,
          scoreModel: run.model, scoredAt: deps.now(), personaSnapshot: input.persona }))).returning({ id: topics.id });
        return { collectionId: input.collectionId, topicIds: rows.map(row => row.id), count: rows.length };
      },
    },
    topic_score: {
      check: scoreCurrent,
      retry: scoreCurrent,
      execute: async (run, controls) => {
        const input = run.frozenInput as ScoreInput;
        await controls.progress("scoring", ["已冻结选题版本与账号人设", "正在深评七个维度"]);
        return parse(await deps.ai.complete(input.system, input.user, { model: run.model, json: true }), scoreSchema);
      },
      apply: async (db, run, result) => {
        if (!await scoreCurrent(db, run)) return null;
        const input = run.frozenInput as ScoreInput, score = result as Score;
        const value = weightedScore(score.scoreDetail);
        const [row] = await db.update(topics).set({ score: value, scoreDetail: score.scoreDetail, scoreMethod: TOPIC_SCORE_METHOD,
          scoreModel: run.model, scoredAt: deps.now(), personaSnapshot: input.persona, updatedAt: deps.now() })
          .where(and(eq(topics.id, input.topic.id), eq(topics.userId, run.userId), sql`${topics.updatedAt}::text=${input.topic.updatedAtToken}`)).returning({ id: topics.id });
        return row ? { topicId: row.id, score: value, verdict: score.verdict, advice: score.advice } : null;
      },
    },
  };
}
