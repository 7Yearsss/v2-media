import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { env } from "../env";
import { drafts } from "../db/schema";
import { createTopicGenerationRun, createTopicScoreRun } from "../lib/topic-ai-run";
import { AiRunConflict } from "../lib/ai-runs";
import { personaForPrompt, resolveAccountPersona } from "../lib/account-persona";

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

export { TOPIC_SCORE_METHOD } from "../lib/topic-ai-run";
const aiTopicsSchema = z.object({
  collectionId: z.number().int().positive(),
  count: z.number().int().min(1).max(10).default(5),
  accountId: z.number().int().positive().optional(),
  operationId: z.string().uuid().optional(),
});
const topicScoreSchema = z.object({ topicId: z.number().int().positive(), operationId: z.string().uuid().optional() });

const rewriteSchema = z.object({
  draftId: z.number().int().positive().optional(),
  accountId: z.number().int().positive().nullable().optional(),
  title: z.string().optional(),
  content: z.string().optional(),
  instruction: z.string().optional(),
});
const titlesSchema = z.object({
  draftId: z.number().int().positive().optional(),
  accountId: z.number().int().positive().nullable().optional(),
  title: z.string().default(""),
  content: z.string().default(""),
  count: z.number().int().min(1).max(10).default(5),
});
const tagsSchema = titlesSchema;

export function aiModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();

  const loadText = async (userId: number, body: z.infer<typeof rewriteSchema>) => {
    const [d] = body.draftId ? await deps.db.select().from(drafts).where(and(eq(drafts.id, body.draftId), eq(drafts.userId, userId))).limit(1) : [];
    if (body.draftId && !d) return { error: "draft not found", code: 404 as const };
    if (d?.archivedAt) return { error: "草稿已归档，请恢复后再使用 AI", code: 409 as const };
    const persona = await resolveAccountPersona(deps.db, userId, body.accountId !== undefined ? body.accountId : d?.accountId);
    if ("error" in persona) return { error: persona.error, code: persona.code };
    return { title: body.title ?? d?.title ?? "", content: body.content ?? d?.content ?? "", persona: persona.snapshot };
  };

  app.post("/rewrite", async (c) => {
    const parsed = rewriteSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    const input = await loadText(c.get("userId"), parsed.data);
    if ("error" in input) return c.json({ error: input.error }, input.code);
    if (!input.title && !input.content)
      return c.json({ error: "nothing to rewrite" }, 400);
    try {
      const content = await deps.ai.complete(
        "你是小红书内容运营编辑，保留事实，遵循输入的账号定位、风格和红线，改写成自然、可发布的种草笔记。未配置人设时保留原文emoji风格，避免夸张营销词。",
        [personaForPrompt(input.persona), `改写要求：${parsed.data.instruction || "提升表达、增强小红书语感"}\n\n标题：${input.title}\n\n正文：\n${input.content}`].filter(Boolean).join("\n\n"),
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
    const input = await loadText(c.get("userId"), parsed.data);
    if ("error" in input) return c.json({ error: input.error }, input.code);
    try {
      const out = await deps.ai.complete(
        "你是小红书标题优化专家，只输出标题列表，每行一个，不要序号。",
        [personaForPrompt(input.persona), `给 ${parsed.data.count} 个小红书标题。\n原标题：${input.title}\n正文：${input.content.slice(0, 2000)}`].filter(Boolean).join("\n\n"),
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
    const input = await loadText(c.get("userId"), parsed.data);
    if ("error" in input) return c.json({ error: input.error }, input.code);
    try {
      const out = await deps.ai.complete(
        "你是小红书 SEO 和话题标签专家。只输出标签，逗号或换行分隔，不带 # 号。",
        [personaForPrompt(input.persona), `给 ${parsed.data.count} 个小红书话题标签。\n标题：${input.title}\n正文：${input.content.slice(0, 2000)}`].filter(Boolean).join("\n\n"),
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

  // Freeze input and enqueue in one transaction; model work belongs to the persistent worker.
  app.post("/topics", async (c) => {
    const parsed = aiTopicsSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    try {
      const result = await createTopicGenerationRun(deps, c.get("userId"), parsed.data);
      if ("error" in result) return c.json({ error: result.error }, result.code);
      return c.json(result.run, 202);
    } catch (error) {
      if (error instanceof AiRunConflict) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  app.post("/topic-score", async (c) => {
    const parsed = topicScoreSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "bad payload" }, 400);
    try {
      const result = await createTopicScoreRun(deps, c.get("userId"), parsed.data);
      if ("error" in result) return c.json({ error: result.error }, result.code);
      return c.json(result.run, 202);
    } catch (error) {
      if (error instanceof AiRunConflict) return c.json({ error: error.message }, 409);
      throw error;
    }
  });

  return app;
}
