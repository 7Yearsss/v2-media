import type { CollectionInsight } from "@v2media/shared";

import { jsonObjectsIn } from "./json-extract";

type RawRef = unknown;
type Resolve = (r: RawRef) => { id: number; title: string } | null;

const asStr = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const asArr = (v: unknown) => (Array.isArray(v) ? v : []);

const cjkCount = (s: string) => (s.match(/[一-龥]/g) ?? []).length;

/**
 * 能直接给用户看的最低质量：判词和结论是中文、结论不少于 2 条。
 * 模型偶尔会把思考草稿（英文占位的 JSON）当成输出，这种要被淘汰并触发重试。
 */
export function isUsableInsight(i: CollectionInsight | null): boolean {
  if (!i || cjkCount(i.summary) < 6) return false;
  const f = i.findings ?? [];
  if (f.length < 2) return false;
  return f.filter((x) => cjkCount(x.claim) >= 3).length >= Math.ceil(f.length / 2);
}

/**
 * 从模型输出里抠出 JSON 洞察。输出里可能有草稿、说明、终稿多个对象：
 * 优先取“质量合格”的最后一个，其次取最后一个能解析的；都没有返回 null（原文进 report 兜底）。
 * refs 由 resolve 映射成笔记。
 */
export function parseInsight(text: string, resolve: Resolve = () => null): CollectionInsight | null {
  const all = jsonObjectsIn(text)
    .reverse()
    .map((raw) => parseOne(raw, resolve))
    .filter((x): x is CollectionInsight => !!x);
  return all.find(isUsableInsight) ?? all[0] ?? null;
}

function parseOne(raw: string, resolve: Resolve): CollectionInsight | null {
  try {
    const j = JSON.parse(raw);
    const refs = (v: unknown) => asArr(v).map(resolve).filter((x): x is { id: number; title: string } => !!x).slice(0, 4);
    const insight: CollectionInsight = {
      summary: asStr(j.summary, 120),
      findings: asArr(j.findings)
        .map((f: any) => ({
          claim: asStr(f?.claim, 80),
          evidence: asArr(f?.evidence).map((e) => asStr(e, 80)).filter(Boolean).slice(0, 3),
          boundary: asStr(f?.boundary, 80),
          todo: asStr(f?.todo, 80),
          confidence: (["high", "mid", "low"].includes(f?.confidence) ? f.confidence : "mid") as "high" | "mid" | "low",
          refs: refs(f?.refs),
        }))
        .filter((f) => f.claim),
      needs: asArr(j.needs)
        .map((n: any) => ({ need: asStr(n?.need, 60), quote: asStr(n?.quote, 100), refs: refs(n?.refs) }))
        .filter((n) => n.need),
      traps: asArr(j.traps)
        .map((t: any) => ({ title: asStr(t?.title, 120), reason: asStr(t?.reason, 80) }))
        .filter((t) => t.title),
      ideas: asArr(j.ideas)
        .map((i: any) => ({ title: asStr(i?.title, 120), hook: asStr(i?.hook, 100), angle: asStr(i?.angle, 100), refs: refs(i?.refs) }))
        .filter((i) => i.title),
    };
    // 模型返回了无关 JSON（如 {"error":...}）时视为解析失败，走原文兜底
    const usable = insight.summary || insight.findings?.length || insight.needs?.length || insight.ideas?.length;
    return usable ? insight : null;
  } catch {
    return null;
  }
}
