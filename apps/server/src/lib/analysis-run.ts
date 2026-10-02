import type { AccountPersonaSnapshot, AnalysisSignals, AnalysisStage, AnalysisVideoBreakdown, AnalysisVisualItem } from "@v2media/shared";

import type { Deps } from "../context";
import { env } from "../env";
import type { AiPart } from "../modules/ai";
import { HYPOTHESIS_SYSTEM, REPORT_SYSTEM, VIDEO_SYSTEM, VISION_SYSTEM } from "./analysis-prompts";
import { engagementOf, signalsForPrompt } from "./analysis-signals";
import { isUsableInsight, parseInsight } from "./insight-parse";
import { personaForPrompt } from "./account-persona";
import { AiRunObsolete } from "./ai-runs";

/** 分析需要的笔记字段（路由查库后传入）。ref = 候选池里的互动排名，AI 只引用编号。 */
export interface RunNote {
  id: number;
  ref: number;
  noteId: string;
  type: string;
  title: string;
  cover: string;
  /** 存进 R2 的视频地址（没转存成功或不是视频则空）。 */
  videoUrl: string | null;
  videoSize: number | null;
  videoDurationMs: number | null;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  tags: string[];
  content: string;
  /** Frozen content already contains the exact normalized excerpt used by the prompt. */
  contentForPrompt?: boolean;
  hasDetail: boolean;
  publishedAt: Date | null;
  sourceKeyword: string;
  commentsData: unknown[];
}

export interface RunInput {
  models?: { analysis: string; vision: string };
  prompts?: { hypothesis: string; report: string; video: string; vision: string };
  colName: string;
  positioning: string;
  persona?: AccountPersonaSnapshot | null;
  /** 候选池（按互动降序）。 */
  pool: RunNote[];
  /** 进 AI 样本的笔记（总互动 top ∪ 日均互动 top）。 */
  sample: RunNote[];
  signals: AnalysisSignals;
  now: Date;
  /** 是否拆视频（默认否）。 */
  withVideo?: boolean;
  /** 进入新阶段时回调（写进度，页面轮询展示）；失败不影响分析。 */
  onStage?: (stage: AnalysisStage, steps: AnalysisStage[]) => Promise<void> | void;
  /** Worker-only cancellation/lease fence; never part of a stored JSON snapshot. */
  assertActive?: () => Promise<void>;
}

const HIT_VISUAL = 8;
const CONTRAST_VISUAL = 4;
const IMG_MAX_BYTES = 1_500_000;
/** 看视频的数量与体积上限：一条视频要 base64 内嵌进请求（34MB ≈ 55s），再大网关和耗时都扛不住。 */
const VIDEO_MAX_COUNT = 3;
const VIDEO_MAX_BYTES = 40_000_000;

type Cmt = { content?: string; likes?: number };
const topComments = (raw: unknown[], n = 3): Array<{ content: string; likes: number }> =>
  (Array.isArray(raw) ? (raw as Cmt[]) : [])
    .map((c) => ({ content: String(c?.content ?? "").slice(0, 120), likes: Number(c?.likes ?? 0) }))
    .filter((c) => c.content)
    .sort((a, b) => b.likes - a.likes)
    .slice(0, n);

/** Freeze precisely what this pipeline sends, without raw comments/replies or platform fields. */
export const analysisPromptComments = (raw: unknown[]) => topComments(raw, 3);

/** 去掉 #话题[话题]# 标记，剩下作者真正写的话。 */
const bodyText = (s: string) =>
  s
    .replace(/#[^#\s]+?(\[话题\])?#?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
export const analysisPromptBody = (text: string) => bodyText(text).slice(0, 500);

const bigrams = (s: string) => {
  const cs = [...s.replace(/\s/g, "")];
  return new Set(cs.slice(0, -1).map((c, i) => c + cs[i + 1]));
};
const jaccard = <T>(a: Set<T>, b: Set<T>) => {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** 对照组：每篇爆款配一篇"同类但没火"的笔记（标签/标题相近），差异才说明问题。 */
export function contrastPairs(pool: RunNote[], hitCount: number, max = 6) {
  const hits = pool.slice(0, hitCount);
  const rest = pool.slice(hitCount).filter((n) => n.hasDetail);
  const used = new Set<number>();
  const pairs: Array<{ hit: RunNote; low: RunNote }> = [];
  for (const h of hits) {
    let best: { n: RunNote; score: number } | null = null;
    for (const n of rest) {
      if (used.has(n.id)) continue;
      const score =
        jaccard(new Set(h.tags), new Set(n.tags)) * 2 + jaccard(bigrams(h.title), bigrams(n.title)) + (h.type === n.type ? 0.3 : 0);
      if (!best || score > best.score) best = { n, score };
    }
    if (best && best.score > 0.5 && engagementOf(best.n) < engagementOf(h) / 2) {
      used.add(best.n.id);
      pairs.push({ hit: h, low: best.n });
    }
    if (pairs.length >= max) break;
  }
  return pairs;
}

/** 读封面：让多模态模型看图，描述封面类型/图上文字/点击理由。失败不影响主流程。 */
async function describeCovers(deps: Deps, targets: RunNote[], input: RunInput): Promise<Map<number, { kind: string; text: string; hook: string }>> {
  const out = new Map<number, { kind: string; text: string; hook: string }>();
  const parts: AiPart[] = [{ type: "text", text: "按编号逐张描述下面的封面。" }];
  let n = 0;
  for (const t of targets) {
    await input.assertActive?.();
    if (!/^https?:\/\//.test(t.cover)) continue;
    try {
      const res = await fetch(t.cover, { signal: AbortSignal.timeout(15_000) });
      await input.assertActive?.();
      const ct = res.headers.get("content-type") ?? "";
      if (!res.ok || !ct.startsWith("image/")) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      await input.assertActive?.();
      if (buf.length > IMG_MAX_BYTES) continue;
      parts.push({ type: "text", text: `编号 ${t.ref}` });
      parts.push({ type: "image_url", image_url: { url: `data:${ct};base64,${buf.toString("base64")}` } });
      n++;
    } catch (error) {
      if (error instanceof AiRunObsolete) throw error;
      /* 取不到就跳过这张 */
    }
  }
  if (!n) return out;
  await input.assertActive?.();
  const text = await deps.ai.complete(input.prompts?.vision ?? VISION_SYSTEM, parts, { model: input.models?.vision ?? (env.aiVisionModel || env.aiAnalysisModel) });
  for (const line of text.split("\n")) {
    const m = line.match(/\{.*\}/);
    if (!m) continue;
    try {
      const j = JSON.parse(m[0]);
      const ref = Number(j.ref);
      if (Number.isInteger(ref)) out.set(ref, { kind: String(j.kind ?? "").slice(0, 20), text: ["空", "无", "没有", "无文字", "无字"].includes(String(j.text ?? "").trim()) ? "" : String(j.text ?? "").slice(0, 60), hook: String(j.hook ?? "").slice(0, 80) });
    } catch {
      /* 非 JSON 行忽略 */
    }
  }
  return out;
}

/** 拆视频：只看已转存到我们 R2 的爆款视频，逐条并行；单条失败不影响其他。 */
async function describeVideos(deps: Deps, targets: RunNote[], input: RunInput): Promise<Map<number, AnalysisVideoBreakdown>> {
  const out = new Map<number, AnalysisVideoBreakdown>();
  await Promise.all(
    targets.map(async (t) => {
      await input.assertActive?.();
      try {
        const res = await fetch(t.videoUrl!, { signal: AbortSignal.timeout(60_000) });
        await input.assertActive?.();
        if (!res.ok) return;
        const buf = Buffer.from(await res.arrayBuffer());
        await input.assertActive?.();
        if (buf.length > VIDEO_MAX_BYTES) return;
        // R2 对象的 content-type 是 octet-stream，网关要 video/mp4 才当视频处理
        const parts: AiPart[] = [
          { type: "text", text: "拆解这条视频。" },
          { type: "image_url", image_url: { url: `data:video/mp4;base64,${buf.toString("base64")}` } },
        ];
        const text = await deps.ai.complete(input.prompts?.video ?? VIDEO_SYSTEM, parts, { model: input.models?.vision ?? (env.aiVisionModel || env.aiAnalysisModel) });
        const m = text.match(/\{[\s\S]*\}/);
        if (!m) return;
        const j = JSON.parse(m[0]);
        const str = (v: unknown, max: number) => String(v ?? "").slice(0, max);
        out.set(t.ref, {
          opening: { visual: str(j.opening?.visual, 80), line: str(j.opening?.line, 60) },
          segments: (Array.isArray(j.segments) ? j.segments : [])
            .map((x: any) => ({ from: Number(x?.from), to: Number(x?.to), what: str(x?.what, 40) }))
            .filter((x: { from: number; to: number; what: string }) => Number.isFinite(x.from) && Number.isFinite(x.to) && x.to > x.from && x.what)
            .slice(0, 8),
          voiceover: str(j.voiceover, 120),
          onscreen: (Array.isArray(j.onscreen) ? j.onscreen : []).map((x: unknown) => str(x, 40)).filter(Boolean).slice(0, 5),
          ending: str(j.ending, 80),
          ...(t.videoDurationMs ? { durationSec: Math.round(t.videoDurationMs / 1000) } : {}),
        });
      } catch (e) {
        if (e instanceof AiRunObsolete) throw e;
        console.warn(`analyze video #${t.ref} failed:`, e instanceof Error ? e.message : e);
      }
    }),
  );
  return out;
}

const eng = engagementOf;
const videoText = (v: AnalysisVideoBreakdown) =>
  `开头：${v.opening.visual}${v.opening.line ? `，第一句「${v.opening.line}」` : ""}｜分段：${v.segments.map((x) => `${x.from}-${x.to}s ${x.what}`).join("；")}｜口播：${v.voiceover}${v.onscreen.length ? `｜画面字：${v.onscreen.join(" / ")}` : ""}｜结尾：${v.ending}`;
const dayAge = (n: RunNote, now: Date) =>
  n.publishedAt ? Math.max(1, Math.ceil((now.getTime() - n.publishedAt.getTime()) / 86_400_000)) : null;

/** 跑完整条 AI 流水线：看封面 → 提假设（含对照组）→ 审稿出终稿。 */
export async function runAnalysisAI(deps: Deps, input: RunInput): Promise<{ report: string; visual: AnalysisVisualItem[] }> {
  const { pool, sample, signals, now, positioning } = input;
  const hitSet = new Set(pool.slice(0, signals.sample.hit).map((n) => n.id));
  const steps: AnalysisStage[] = input.withVideo
    ? ["signals", "covers", "videos", "hypotheses", "report"]
    : ["signals", "covers", "hypotheses", "report"];
  const stage = async (s: AnalysisStage) => {
    await input.assertActive?.();
    try {
      await input.onStage?.(s, steps);
    } catch (error) {
      if (error instanceof AiRunObsolete) throw error;
      /* 进度只是展示，写失败别拖垮分析 */
    }
  };
  await stage("covers");

  // 1. 看封面：爆款 top N + 对照组
  const pairs = contrastPairs(pool, signals.sample.hit);
  const targets = [...pool.slice(0, HIT_VISUAL), ...pairs.map((p) => p.low).slice(0, CONTRAST_VISUAL)];
  const seen = new Set<number>();
  const uniq = targets.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  let covers = new Map<number, { kind: string; text: string; hook: string }>();
  try {
    covers = await describeCovers(deps, uniq, input);
  } catch (e) {
    if (e instanceof AiRunObsolete) throw e;
    console.warn("analyze vision failed:", e instanceof Error ? e.message : e);
  }
  // 拆视频默认关：慢（每条 ~1 分钟 + 下载十几 MB）、只覆盖少数笔记，收益远小于封面/正文/评论。需要时再开。
  const videoTargets = (input.withVideo ? pool : [])
    .slice(0, signals.sample.hit + 4)
    .filter((n) => n.type === "video" && n.videoUrl?.includes("/objects/vid/") && (n.videoSize ?? 0) <= VIDEO_MAX_BYTES)
    .slice(0, VIDEO_MAX_COUNT);
  if (videoTargets.length) await stage("videos");
  const videos = videoTargets.length ? await describeVideos(deps, videoTargets, input).catch(error => {
    if (error instanceof AiRunObsolete) throw error;
    return new Map<number, AnalysisVideoBreakdown>();
  }) : new Map<number, AnalysisVideoBreakdown>();
  const visual: AnalysisVisualItem[] = uniq
    .filter((n) => covers.has(n.ref))
    .map((n) => ({ ref: n.ref, id: n.id, title: n.title, cover: n.cover, ...covers.get(n.ref)!, hit: hitSet.has(n.id), engagement: eng(n), ...(videos.has(n.ref) ? { video: videos.get(n.ref)! } : {}) }));

  // 2. 第一步上下文：爆款给全文，其余给节选；带封面描述
  const line = (n: RunNote) => {
    const days = dayAge(n, now);
    const cm = topComments(n.commentsData);
    const cv = covers.get(n.ref);
    const body = (n.contentForPrompt ? n.content : analysisPromptBody(n.content)).slice(0, hitSet.has(n.id) ? 500 : 120);
    return JSON.stringify({
      编号: `#${n.ref}`,
      标题: n.title,
      类型: n.type === "video" ? "视频" : "图文",
      赞: n.likes,
      收藏: n.collects,
      评论: n.comments,
      分享: n.shares,
      ...(days ? { 上线天数: days, 日均互动: Math.round(eng(n) / days) } : {}),
      ...(n.sourceKeyword ? { 搜索词: n.sourceKeyword } : {}),
      ...(cv ? { 封面: `${cv.kind}｜图上文字：${cv.text || "无"}｜${cv.hook}` } : {}),
      ...(videos.has(n.ref) ? { 视频拆解: videoText(videos.get(n.ref)!) } : {}),
      正文: body || "（正文为空，内容在图/视频里）",
      ...(cm.length ? { 热门评论: cm.map((x) => `${x.content}（${x.likes}赞）`) } : {}),
    });
  };
  const pairText = pairs.length
    ? pairs
        .map((p) => `#${p.hit.ref}「${p.hit.title}」互动 ${eng(p.hit)} ↔ #${p.low.ref}「${p.low.title}」互动 ${eng(p.low)}（标签/标题相近）`)
        .join("\n")
    : "";
  const context = [
    `采集库「${input.colName}」共 ${pool.length} 篇`,
    input.persona ? personaForPrompt(input.persona) : positioning ? `目标账号定位：${positioning}` : "",
    `【信号】\n${signalsForPrompt(signals)}`,
    pairText ? `【对照：同类内容，一篇火一篇没火】\n${pairText}` : "",
    `【笔记】\n${sample.map(line).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 3. 终稿上下文：只要编号/标题/互动/评论原话/封面一句话，核对假设用——网关单次请求超 100s 会被 CF 切断
  const brief = sample
    .map((n) => {
      const cm = topComments(n.commentsData);
      const cv = covers.get(n.ref);
      return `#${n.ref} ${n.title}｜${eng(n)}${cv ? `｜封面：${cv.kind}，${cv.text || "无字"}` : ""}${videos.has(n.ref) ? `｜视频：${videos.get(n.ref)!.voiceover}` : ""}${cm.length ? `｜评论：${cm.map((x) => x.content).join(" / ")}` : ""}`;
    })
    .join("\n");
  const reviewContext = [
    input.persona ? personaForPrompt(input.persona) : positioning ? `目标账号定位：${positioning}` : "",
    `【信号】\n${signalsForPrompt(signals)}`,
    pairText ? `【对照】\n${pairText}` : "",
    `【笔记索引】\n${brief}`,
  ]
    .filter(Boolean)
    .join("\n\n");

  // 分析要稳：温度低一点，两次输出差异才小
  const model = { model: input.models?.analysis ?? env.aiAnalysisModel, temperature: 0.3 };
  const t0 = Date.now();
  await stage("hypotheses");
  const hypotheses = await deps.ai.complete(input.prompts?.hypothesis ?? HYPOTHESIS_SYSTEM, context, model);
  if (process.env.ANALYSIS_DEBUG) console.info(`【假设】\n${hypotheses}`);
  const t1 = Date.now();
  await stage("report");
  const reportInput = `${reviewContext}\n\n【上一步假设】\n${hypotheses}`;
  let report = await deps.ai.complete(input.prompts?.report ?? REPORT_SYSTEM, reportInput, { ...model, json: true });
  // 模型偶尔把思考草稿（英文占位 JSON）当终稿：质量不合格就让它重写一次
  if (!isUsableInsight(parseInsight(report))) {
    console.warn("analyze report unusable, retrying once");
    const retry = await deps.ai.complete(
      input.prompts?.report ?? REPORT_SYSTEM,
      `${reportInput}\n\n上一次的输出不能用：必须只输出一个 JSON，所有内容用中文，结论要引用上面的真实数据。请重新输出。`,
      { ...model, json: true },
    );
    if (isUsableInsight(parseInsight(retry))) report = retry;
  }
  console.info(
    `analyze AI ok: covers ${covers.size}/${uniq.length}, videos ${videos.size}/${videoTargets.length}, hypotheses ${t1 - t0}ms (in ${context.length}字), report ${Date.now() - t1}ms (in ${reviewContext.length}字)`,
  );
  return { report, visual };
}
