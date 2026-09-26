import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";

import type { Deps } from "../context";
import { env } from "../env";
import { drafts } from "../db/schema";

/** OpenAI 兼容 chat 客户端 —— fetch 可注入（测试里 mock）。 */
export interface AiClient {
  complete(system: string, user: string): Promise<string>;
}

export function createOpenAiClient(
  fetchFn: typeof fetch = fetch,
): AiClient {
  return {
    async complete(system, user) {
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
          model: env.aiModel,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          temperature: 0.7,
        }),
      });
      if (!res.ok) throw new Error(`AI request failed: ${res.status}`);
      const payload = (await res.json()) as any;
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || !content.trim()) throw new Error("empty AI response");
      return content.trim();
    },
  };
}

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

  return app;
}
