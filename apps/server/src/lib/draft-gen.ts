import { checkBannedWords, summarizeBanned } from "@v2media/shared";

import type { Deps } from "../context";
import { env } from "../env";
import { jsonObjectsIn } from "./json-extract";

/** 选题一键成稿：借爆款的结构，换成选题和定位说的事；写完自查违禁词，命中就让模型改一次。 */
export const DRAFT_SYSTEM = `你在帮一个小红书账号写下一篇笔记。输入有选题（标题、开头钩子、借鉴思路）、被借鉴的爆款笔记，可能还有账号定位。
借爆款的结构：先抛什么、怎么分段、读者能拿走什么；内容换成选题和定位要说的事，不要照搬原文，因为平台会判定搬运，读者也会觉得眼熟。
正文写给手机上扫读的人：短段落，每段一个意思，第一句就是钩子，结尾留一个读者能回答的问题。
涉及操作步骤、数据或安全的细节，输入里没有依据的不要编，写得保守并提醒以实际情况为准，因为读者会照着做。
不要用“最、第一、绝对、保证、治愈”这类极限和承诺用语，也不要留联系方式或求赞求关注，这些会被限流。
只输出一个 JSON 对象：{"title":"标题≤20字","content":"正文300-600字，段落之间用换行分隔","tags":["5-8个话题，不带#"],"cover":"封面大字≤12字，不用emoji","coverPoints":["正文里的2-4个短要点，每项≤20字，没有就空数组"],"coverComparison":{"left":"正文中对比的一侧≤24字","right":"另一侧≤24字"}}
coverPoints和coverComparison只摘正文已有内容，不为凑封面编步骤、效果或数字；没有明确对比时coverComparison输出null。`;

export interface DraftSource {
  title: string;
  hook?: string;
  angle?: string;
  positioning?: string;
  note?: { title: string; content: string; tags: string[] };
}

export interface GeneratedDraft {
  title: string;
  content: string;
  tags: string[];
  cover: string;
  coverPoints?: string[];
  coverComparison?: { left: string; right: string };
  /** 自查后仍命中的违禁词（空 = 干净）。 */
  warnings: Array<{ word: string; kind: string; count: number }>;
}

const cleanBody = (s: string) => s.replace(/#[^#\s]+?(\[话题\])?#?/g, " ").replace(/[ \t]+/g, " ").trim();

function parse(text: string): Omit<GeneratedDraft, "warnings"> | null {
  for (const raw of jsonObjectsIn(text).reverse()) {
    try {
      const j = JSON.parse(raw);
      const title = String(j.title ?? "").trim().slice(0, 40);
      const content = String(j.content ?? "").trim();
      if (!title || !content) continue;
      return {
        title,
        content,
        tags: (Array.isArray(j.tags) ? j.tags : []).map((t: unknown) => String(t).replace(/^#/, "").trim()).filter(Boolean).slice(0, 10),
        cover: String(j.cover ?? "").trim().slice(0, 20),
        coverPoints: (Array.isArray(j.coverPoints) ? j.coverPoints : []).filter((p: unknown) => typeof p === "string" && p.trim()).slice(0, 4).map((p: string) => p.trim().slice(0, 28)),
        ...(typeof j.coverComparison?.left === "string" && typeof j.coverComparison?.right === "string"
          ? { coverComparison: { left: j.coverComparison.left.trim().slice(0, 40), right: j.coverComparison.right.trim().slice(0, 40) } } : {}),
      };
    } catch {
      /* 试下一个对象 */
    }
  }
  return null;
}

export async function generateDraft(deps: Deps, src: DraftSource): Promise<GeneratedDraft> {
  const input = [
    src.positioning ? `账号定位：${src.positioning}` : "",
    `选题标题：${src.title}`,
    src.hook ? `开头钩子：${src.hook}` : "",
    src.angle ? `借鉴思路：${src.angle}` : "",
    src.note
      ? `被借鉴的爆款：\n标题：${src.note.title}\n正文：${cleanBody(src.note.content).slice(0, 600) || "（正文为空，内容在图里）"}\n标签：${src.note.tags.slice(0, 8).join("、")}`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const opts = { model: env.aiAnalysisModel, temperature: 0.7 };
  let out = parse(await deps.ai.complete(DRAFT_SYSTEM, input, opts));
  if (!out) throw new Error("AI 没有返回可用的草稿");
  // 自查：命中违禁词就让模型改一次（只改命中的表述，别改结构）
  const wordsToCheck = (d: Omit<GeneratedDraft, "warnings">) =>
    [d.title, d.content, d.cover, ...(d.coverPoints ?? []), d.coverComparison?.left, d.coverComparison?.right].filter(Boolean).join("\n");
  let hits = checkBannedWords(wordsToCheck(out));
  if (hits.length) {
    const words = [...new Set(hits.map((h) => h.word))].join("、");
    const retry = parse(
      await deps.ai.complete(
        DRAFT_SYSTEM,
        `${input}\n\n上一版里这些词会被限流：${words}。请保持结构不变，只把这些表述换成具体、可验证的说法，重新输出 JSON。`,
        opts,
      ),
    );
    if (retry) {
      out = retry;
      hits = checkBannedWords(wordsToCheck(out));
    }
  }
  return { ...out, warnings: summarizeBanned(hits) };
}
