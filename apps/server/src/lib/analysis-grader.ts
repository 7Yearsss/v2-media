import type { CollectionInsight } from "@v2media/shared";

/** 评分输入：被分析的库（标题 + 评论原话）。 */
export interface GradeContext {
  titles: string[];
  comments: string[];
}

export interface GradeResult {
  /** 0-100。 */
  score: number;
  /** 未通过的检查项（空 = 全过）。 */
  failures: string[];
}

/** 形容词式的空话：读完不知道怎么做。claim/todo 里出现就算失败。 */
const VAGUE = /增强|提升|强化|优化|赋能|打造|聚焦|代入感|吸引力|共鸣感|沉浸|情绪价值|差异化|用户粘性|心智/;

const LIMITS = { summary: 40, claim: 24, evidence: 30, boundary: 30, todo: 30, need: 20, quote: 40, ideaTitle: 28, hook: 36 };

/**
 * 报告评分器：只查能机械判断的失败模式，作为提示词评测的底线。
 * 用法：测试里对 mock 输出打分；也可对真实模型输出批量跑（见 test/analysis-eval.test.ts 的说明）。
 */
export function gradeInsight(insight: CollectionInsight | null, ctx: GradeContext): GradeResult {
  const failures: string[] = [];
  if (!insight) return { score: 0, failures: ["结构化解析失败"] };

  const long = (label: string, s: string, max: number) => {
    if ([...s].length > max) failures.push(`${label} 超长（${[...s].length}>${max}）：${s.slice(0, 12)}…`);
  };
  long("summary", insight.summary, LIMITS.summary);
  if (!insight.summary) failures.push("缺少 summary");
  // 只有数字没有判断：summary 里一半以上是数字/符号，多半是在复述数据
  const letters = [...insight.summary].filter((c) => /[一-龥a-zA-Z]/.test(c)).length;
  if (insight.summary && letters < 6) failures.push("summary 像数据复述，没有判断");

  const findings = insight.findings ?? [];
  if (findings.length < 2) failures.push("findings 少于 2 条");
  findings.forEach((f, i) => {
    long(`findings[${i}].claim`, f.claim, LIMITS.claim);
    f.evidence.forEach((e) => long(`findings[${i}].evidence`, e, LIMITS.evidence));
    long(`findings[${i}].boundary`, f.boundary, LIMITS.boundary);
    long(`findings[${i}].todo`, f.todo, LIMITS.todo);
    if (VAGUE.test(f.claim) || VAGUE.test(f.todo)) failures.push(`findings[${i}] 是形容词式空话，没法照做：${f.claim}/${f.todo}`);
    if (!f.evidence.length) failures.push(`findings[${i}] 没有证据`);
    if (!f.boundary) failures.push(`findings[${i}] 没写不成立的条件`);
    if (!f.todo) failures.push(`findings[${i}] 没写怎么做`);
    if (f.confidence === "high" && !(f.refs?.length || f.evidence.some((e) => /\d/.test(e)))) {
      failures.push(`findings[${i}] 高置信但证据里没有数字也没有引用笔记`);
    }
  });

  // 评论原话必须真的出现在评论里（防编造）：取前 8 个字做子串匹配
  for (const [i, n] of (insight.needs ?? []).entries()) {
    long(`needs[${i}].need`, n.need, LIMITS.need);
    long(`needs[${i}].quote`, n.quote, LIMITS.quote);
    const probe = n.quote.replace(/[…\s.。]/g, "").slice(0, 8);
    if (probe && !ctx.comments.some((c) => c.replace(/\s/g, "").includes(probe))) {
      failures.push(`needs[${i}] 的评论原话在库里找不到：${n.quote}`);
    }
  }

  // 选题要能直接发：有钩子、不照搬库里已有标题
  const existing = new Set(ctx.titles.map((t) => t.trim()));
  const ideas = insight.ideas ?? [];
  if (ideas.length < 3) failures.push("ideas 少于 3 条");
  for (const [i, idea] of ideas.entries()) {
    long(`ideas[${i}].title`, idea.title, LIMITS.ideaTitle);
    long(`ideas[${i}].hook`, idea.hook, LIMITS.hook);
    if (existing.has(idea.title.trim())) failures.push(`ideas[${i}] 照搬了库里的原标题`);
    if (!idea.hook) failures.push(`ideas[${i}] 缺开头钩子`);
    if (!idea.refs?.length) failures.push(`ideas[${i}] 没有来源笔记`);
  }

  const score = Math.max(0, 100 - failures.length * 8);
  return { score, failures };
}
