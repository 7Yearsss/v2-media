import { and, desc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { env } from "../env";
import { collectedNotes, collections, drafts, hostedAccounts, topics } from "../db/schema";

/** OpenAI 兼容 chat 客户端 —— fetch 可注入（测试里 mock）。 */
/** 多模态消息片段（OpenAI 兼容格式；图片用 data URL 内嵌，网关不会替我们去取外链）。 */
export type AiPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

export interface AiClient {
  /** opts.model：本次调用覆盖默认模型（分析要用响应快的，网关 100s 会切断长请求）。 */
  complete(system: string, user: string | AiPart[], opts?: { model?: string; temperature?: number; json?: boolean }): Promise<string>;
}

export function createOpenAiClient(
  fetchFn: typeof fetch = fetch,
): AiClient {
  return {
    async complete(system, user, opts) {
      if (!env.aiBaseUrl || !env.aiApiKey) throw new Error("AI not configured (AI_BASE_URL/AI_API_KEY)");
      const res = await fetchFn(`${env.aiBaseUrl}/chat/completions`, {
        method: "POST",
        // 网关不响应时不能挂死请求（分析/改写都走这里）
        signal: AbortSignal.timeout(env.aiTimeoutMs),
        headers: {
          Authorization: `Bearer ${env.aiApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: opts?.model || env.aiModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: opts?.temperature ?? 0.7,
          ...(opts?.json ? { response_format: { type: "json_object" } } : {}),
          // 流式：网关前面有 Cloudflare，非流式的长请求 ~100s 无响应会被切成 524
          stream: true,
        }),
      });
      if (!res.ok || !res.body) throw new Error(`AI request failed: ${res.status}`);
      // 兼容不支持流式、直接回整包 JSON 的网关
      if (!(res.headers.get("content-type") ?? "").includes("text/event-stream")) {
        const payload = (await res.json()) as any;
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== "string" || !content.trim()) throw new Error("empty AI response");
        return content.trim();
      }
      const decoder = new TextDecoder();
      let buf = "";
      let out = "";
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          try {
            const delta = JSON.parse(data)?.choices?.[0]?.delta?.content;
            if (typeof delta === "string") out += delta;
          } catch {
            /* 心跳/非 JSON 行忽略 */
          }
        }
      }
      if (!out.trim()) throw new Error("empty AI response");
      return out.trim();
    },
  };
}

// ---------- 选题评分：七维口径（借 Easel scoring-dimensions），AI 出维度分、服务端加权 ----------

/** 维度权重（综合分 = Σ 维度分/10 × 权重 × 100）。cost/risk 为反向分。 */
const TOPIC_SCORE_WEIGHTS: Record<string, number> = {
  traffic: 25,
  fit: 20,
  diff: 15,
  monetization: 15,
  evergreen: 10,
  cost: 8,
  risk: 7,
};
const SCORE_DIMS = Object.keys(TOPIC_SCORE_WEIGHTS);

/** 七维明细 → 综合分（0-100 取整）。维度缺失按 5 分兜底（不给极端值）。 */
function weightedScore(detail: Record<string, number>): number {
  let sum = 0;
  for (const k of SCORE_DIMS) {
    const v = detail[k];
    const clamped = typeof v === "number" && Number.isFinite(v) ? Math.min(10, Math.max(1, v)) : 5;
    sum += (clamped / 10) * TOPIC_SCORE_WEIGHTS[k]!;
  }
  return Math.round(sum);
}

/** 从模型输出抠 {topics:[...]} 或单选题评分明细；解析失败返回 null。 */
function parseJsonObject(text: string): Record<string, any> | null {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    return j && typeof j === "object" && !Array.isArray(j) ? j : null;
  } catch {
    return null;
  }
}

/** 把 AI 返回的一条选题归一化；不合法返回 null。 */
function normalizeSuggestion(raw: unknown): {
  title: string;
  angle: string;
  scoreDetail: Record<string, number>;
  reason: string;
} | null {
  const o = raw as Record<string, any> | null;
  const title = typeof o?.title === "string" ? o.title.trim() : "";
  if (!title) return null;
  const detailRaw = (o?.scoreDetail ?? {}) as Record<string, unknown>;
  const scoreDetail: Record<string, number> = {};
  for (const k of SCORE_DIMS) {
    const v = detailRaw[k];
    if (typeof v === "number" && Number.isFinite(v)) scoreDetail[k] = v;
  }
  return {
    title: title.slice(0, 512),
    angle: typeof o?.angle === "string" ? o.angle.slice(0, 4000) : "",
    scoreDetail,
    reason: typeof o?.reason === "string" ? o.reason.slice(0, 500) : "",
  };
}

const aiTopicsSchema = z.object({
  collectionId: z.number().int(),
  count: z.number().int().min(1).max(10).default(5),
  accountId: z.number().int().optional(),
});
const topicScoreSchema = z.object({ topicId: z.number().int() });

const TOPIC_GEN_SYSTEM =
  "你是小红书内容策划师。输入是一个采集库里的爆款笔记列表（标题/互动数据/标签/正文节选）。" +
  "基于这些已验证跑通的选题方向，生成 N 个新选题——不是照抄标题，而是提炼爆款规律后沿同赛道换角度。" +
  "每个选题按七个维度打 1-10 分：traffic 流量潜力、fit 账号匹配、diff 竞争差异化、monetization 变现潜力、" +
  "evergreen 时效价值、cost 制作成本(越高越省事)、risk 合规风险(越高越安全)。" +
  "只输出一个 JSON 对象（不要 markdown 围栏），结构：" +
  '{"topics":[{"title":"可直接用的选题标题","angle":"切入角度与要点（2-3 句）",' +
  '"scoreDetail":{"traffic":8,"fit":7,"diff":6,"monetization":5,"evergreen":6,"cost":8,"risk":9},' +
  '"reason":"一句推荐理由，引用库内哪篇笔记的什么数据"}]}';

const TOPIC_SCORE_SYSTEM =
  "你是小红书选题评审。对给定选题逐维展开打分：traffic/fit/diff/monetization/evergreen/cost/risk 各 1-10 " +
  "（cost 越高越省事、risk 越高越安全）。只输出 JSON：" +
  '{"scoreDetail":{"traffic":8,...},"verdict":"做|改方向|不做","advice":"2-3 句具体建议"}';

const rewriteSchema = z.object({
  draftId: z.number().int().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  instruction: z.string().optional(),
});
const titlesSchema = z.object({
  title: z.string().default(""),
  content: z.string().default(""),
  count: z.number().int().min(1).max(10).default(5),
});
const tagsSchema = titlesSchema;

export function aiModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  const loadText = async (c: any, body: z.infer<typeof rewriteSchema>) => {
    if (body.title || body.content) return { title: body.title ?? "", content: body.content ?? "" };
    if (!body.draftId) return null;
    const [d] = await deps.db
      .select()
      .from(drafts)
      .where(and(eq(drafts.id, body.draftId), eq(drafts.userId, c.get("userId"))))
      .limit(1);
    return d ? { title: d.title, content: d.content } : null;
  };

  app.post("/rewrite", async (c) => {
    const parsed = rewriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const input = await loadText(c, parsed.data);
    if (!input || (!input.title && !input.content))
      return c.json({ error: "nothing to rewrite" }, 400);
    try {
      const content = await deps.ai.complete(
        "你是小红书内容运营编辑，在保留事实的前提下改写成自然、可发布的种草笔记。保留emoji风格但避免夸张营销词。",
        `改写要求：${parsed.data.instruction || "提升表达、增强小红书语感"}\n\n标题：${input.title}\n\n正文：\n${input.content}`,
      );
      // 约定模型输出 "标题：...\n正文：..."；否则全部当正文、保留原标题
      const titleLine = content.split("\n").find((l) => l.startsWith("标题："));
      const body = content.includes("正文：")
        ? content.split("正文：", 2)[1]!.trim()
        : content;
      return c.json({ title: titleLine?.replace("标题：", "").trim() || input.title, content: body });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
    }
  });

  app.post("/titles", async (c) => {
    const parsed = titlesSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    try {
      const out = await deps.ai.complete(
        "你是小红书标题优化专家，只输出标题列表，每行一个，不要序号。",
        `给 ${parsed.data.count} 个小红书标题。\n原标题：${parsed.data.title}\n正文：${parsed.data.content.slice(0, 2000)}`,
      );
      const titles = out
        .split("\n")
        .map((l) => l.replace(/^[\s\-*\d.、]+/, "").trim())
        .filter(Boolean)
        .slice(0, parsed.data.count);
      return c.json({ titles });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
    }
  });

  app.post("/tags", async (c) => {
    const parsed = tagsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    try {
      const out = await deps.ai.complete(
        "你是小红书 SEO 和话题标签专家。只输出标签，逗号或换行分隔，不带 # 号。",
        `给 ${parsed.data.count} 个小红书话题标签。\n标题：${parsed.data.title}\n正文：${parsed.data.content.slice(0, 2000)}`,
      );
      const tags = out
        .replace(/，/g, ",")
        .split(/[,\n]/)
        .map((t) => t.trim().replace(/^#/, ""))
        .filter(Boolean)
        .slice(0, parsed.data.count);
      return c.json({ tags });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
    }
  });

  /** 采集库爆款 → 选题池：AI 出选题+七维分，服务端加权算综合分，直接落库（status=idea）。 */
  app.post("/topics", async (c) => {
    const userId = c.get("userId");
    const parsed = aiTopicsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const { collectionId, count, accountId } = parsed.data;
    const [col] = await deps.db
      .select()
      .from(collections)
      .where(and(eq(collections.id, collectionId), eq(collections.userId, userId)))
      .limit(1);
    if (!col) return c.json({ error: "collection not found" }, 404);
    if (accountId) {
      const [acc] = await deps.db
        .select({ id: hostedAccounts.id })
        .from(hostedAccounts)
        .where(and(eq(hostedAccounts.id, accountId), eq(hostedAccounts.userId, userId)))
        .limit(1);
      if (!acc) return c.json({ error: "account not found" }, 404);
    }
    const notes = await deps.db
      .select({
        title: collectedNotes.title,
        likes: collectedNotes.likes,
        collects: collectedNotes.collects,
        comments: collectedNotes.comments,
        shares: collectedNotes.shares,
        tags: collectedNotes.tags,
        content: collectedNotes.content,
      })
      .from(collectedNotes)
      .where(eq(collectedNotes.collectionId, col.id))
      .orderBy(
        desc(sql`${collectedNotes.likes} + ${collectedNotes.collects} + ${collectedNotes.comments} + ${collectedNotes.shares}`),
      )
      .limit(30);
    if (!notes.length) return c.json({ error: "库里还没有笔记，先采集一些" }, 400);
    const payload = notes
      .map((n) =>
        JSON.stringify({
          标题: n.title,
          赞: n.likes,
          收藏: n.collects,
          评论: n.comments,
          分享: n.shares,
          标签: n.tags.slice(0, 8),
          正文节选: n.content.slice(0, 200),
        }),
      )
      .join("\n");
    let raw: string;
    try {
      raw = await deps.ai.complete(
        TOPIC_GEN_SYSTEM,
        `采集库「${col.name}」互动量 Top ${notes.length} 篇：\n${payload}\n\n生成 ${count} 个选题。`,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
    }
    const suggestions = (parseJsonObject(raw)?.topics ?? [])
      .map(normalizeSuggestion)
      .filter(Boolean)
      .slice(0, count);
    if (!suggestions.length) return c.json({ error: "AI 返回格式异常，请重试" }, 502);
    const items = [];
    for (const s of suggestions) {
      const [row] = await deps.db
        .insert(topics)
        .values({
          userId,
          title: s.title,
          angle: s.reason ? `${s.angle}\n\n推荐理由：${s.reason}`.trim() : s.angle,
          sourceType: "ai",
          collectionId: col.id,
          accountId: accountId ?? null,
          status: "idea",
          score: weightedScore(s.scoreDetail),
          scoreDetail: s.scoreDetail,
        })
        .returning();
      items.push(row);
    }
    return c.json({ items }, 201);
  });

  /** 单条选题深评：七维明细 + 结论 + 建议；回写 score/scoreDetail。 */
  app.post("/topic-score", async (c) => {
    const userId = c.get("userId");
    const parsed = topicScoreSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const [topic] = await deps.db
      .select()
      .from(topics)
      .where(and(eq(topics.id, parsed.data.topicId), eq(topics.userId, userId)))
      .limit(1);
    if (!topic) return c.json({ error: "not found" }, 404);
    let raw: string;
    try {
      raw = await deps.ai.complete(
        TOPIC_SCORE_SYSTEM,
        `选题：${topic.title}\n切入角度：${topic.angle || "（未填）"}`,
      );
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : "AI failed" }, 502);
    }
    const j = parseJsonObject(raw);
    const detail = (j?.scoreDetail ?? {}) as Record<string, unknown>;
    const scoreDetail: Record<string, number> = {};
    for (const k of SCORE_DIMS) {
      const v = detail[k];
      if (typeof v === "number" && Number.isFinite(v)) scoreDetail[k] = v;
    }
    const [row] = await deps.db
      .update(topics)
      .set({
        score: weightedScore(scoreDetail),
        scoreDetail,
        updatedAt: deps.now(),
      })
      .where(eq(topics.id, topic.id))
      .returning();
    return c.json({
      topic: row,
      verdict: typeof j?.verdict === "string" ? j.verdict : "",
      advice: typeof j?.advice === "string" ? j.advice : "",
    });
  });

  return app;
}
