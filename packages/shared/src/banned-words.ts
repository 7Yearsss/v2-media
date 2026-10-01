/**
 * 小红书发布前自查（纯函数，前后端共用）：违禁/限流词 + 平台硬限制。
 * 规则按平台公开的限流/违规类型整理，不是官方词库，命中只是提醒，不阻止发布。
 * 原则：宁可少报也别乱报——常见正常说法（“第一次”“第一步”）不能被误伤，否则用户会学会无视提示。
 */

export type BannedKind = "extreme" | "medical" | "efficacy" | "contact" | "promise" | "bait" | "custom";
/** high：容易被限流/下架（导流、功效、承诺、诱导）；low：广告法极限用语，个人分享里风险较小。 */
export type BannedSeverity = "high" | "low";

export interface BannedHit {
  word: string;
  kind: BannedKind;
  severity: BannedSeverity;
  /** 在文本里的起始位置。 */
  index: number;
  /** 建议改成什么；空串 = 建议直接删除；undefined = 没有机械替换，需自己改写。 */
  suggest?: string;
}

export const BANNED_KIND_META: Record<BannedKind, { label: string; hint: string; severity: BannedSeverity }> = {
  extreme: { label: "极限用语", hint: "广告法禁用，换成具体数据或个人体验", severity: "low" },
  medical: { label: "医疗功效", hint: "不能承诺疗效，改成个人体验", severity: "high" },
  contact: { label: "站外导流", hint: "留联系方式/外链会被限流，建议删除", severity: "high" },
  promise: { label: "夸大承诺", hint: "保证/暴富类承诺会被判营销", severity: "high" },
  bait: { label: "诱导互动", hint: "求赞求关注类会被降权，建议删除", severity: "high" },
  efficacy: { label: "功效宣称", hint: "美妆/保健类功效宣称受限，改成个人使用感受", severity: "low" },
  custom: { label: "我的屏蔽词", hint: "你自己加的词", severity: "high" },
};

/** 极限词 → 更稳妥的说法。 */
const EXTREME_SUGGEST: Record<string, string> = {
  最好: "很好",
  最佳: "很不错",
  最强: "很强",
  最低: "很低",
  最低价: "很便宜",
  最便宜: "很便宜",
  最大: "很大",
  最优: "很优秀",
  最快: "很快",
  最高级: "很高级",
  最有效: "挺有效",
  最划算: "很划算",
  最先进: "很先进",
  最专业: "很专业",
  顶级: "优质",
  顶尖: "优质",
  绝对: "真的",
  唯一: "少有的",
  首选: "推荐",
  万能: "多用途",
  史上: "难得",
  秒杀: "优惠",
  销量冠军: "热销",
  全网最: "",
  国家级: "",
  世界级: "",
  极致: "出色",
  无敌: "很强",
};

const MEDICAL_SUGGEST: Record<string, string> = {
  根治: "改善",
  治愈: "缓解",
  治疗: "调理",
  疗效: "体验",
  药到病除: "见效",
  包治: "",
  消炎: "舒缓",
  抗癌: "",
  速效: "见效较快",
  立竿见影: "见效较快",
  排毒: "清爽",
};

const PROMISE_SUGGEST: Record<string, string> = {
  保证: "希望",
  稳赚: "",
  躺赚: "",
  暴富: "",
  包过: "",
  零风险: "风险较低",
  无副作用: "我用着没不适",
};

const EFFICACY_SUGGEST: Record<string, string> = {
  美白: "提亮",
  淡斑: "",
  嫩肤: "",
  紧致: "",
};

// 拆字/谐音/夹符号的变体：微 信、薇.信、v x、w-x
const SEP = "[\\s\\-_.·•|*~❤♥️]*";

interface Rule {
  kind: BannedKind;
  re: RegExp;
  suggest?: (word: string) => string | undefined;
}

const RULES: Rule[] = [
  {
    kind: "extreme",
    // “第一”只在“排名/销量第一、第一品牌”这类宣称里算；“第一次/第一步/第一天”是正常说法，不碰
    re: /最(?:好|佳|强|低价?|便宜|大|优|快|高级|有效|划算|先进|专业)|(?:排名|销量|行业|全网|国内|口碑|好评)第一|第一(?:品牌|名|选择|梯队)|顶级|顶尖|绝对|唯一|首选|万能|全网最|史上|秒杀|销量冠军|国家级|世界级|极致|无敌/g,
    suggest: (w) => EXTREME_SUGGEST[w],
  },
  {
    kind: "medical",
    re: /根治|治愈|治疗|疗效|药到病除|包治|消炎|抗癌|速效|立竿见影|排毒|\d+天(?:瘦|减|白|祛|消)\S{0,3}/g,
    suggest: (w) => MEDICAL_SUGGEST[w],
  },
  {
    kind: "contact",
    re: new RegExp(
      [
        `[微薇威]${SEP}[信芯]`,
        `\\b[vV]${SEP}[xX信]\\b`,
        "加我",
        "二维码|扫码|扫一扫",
        "公众号",
        "淘宝|拼多多|京东链接|小程序链接",
        "手机号|1[3-9]\\d{9}",
        "点击链接|戳链接|看链接",
        "\\bQQ\\b",
      ].join("|"),
      "gi",
    ),
    suggest: () => "",
  },
  {
    kind: "promise",
    // 含金融（保本/年化）、教育（保就业）类的收益/结果承诺
    re: /保证|稳赚|日入|月入(?:过)?[万千]|躺赚|暴富|包过|零风险|无副作用|保本|保息|高收益|无风险|年化\d+(?:\.\d+)?%|包就业|保就业/g,
    suggest: (w) => PROMISE_SUGGEST[w],
  },
  {
    kind: "efficacy",
    // 化妆品/保健类功效宣称；“减肥”“瘦腿”等健身圈常用词不碰，避免噪声
    re: /美白|祛痘|祛斑|淡斑|抗皱|去皱|除皱|生发|增高|丰胸|紧致|嫩肤|抗衰/g,
    suggest: (w) => EFFICACY_SUGGEST[w],
  },
  {
    kind: "extreme",
    re: /100%|百分之百|百分百/g,
    suggest: () => "",
  },
  {
    kind: "bait",
    re: /求赞|求关注|互关|互赞|互粉|点赞收藏必看|不转不是|评论区扣|扣1|主页(?:领|看|有)|看主页|私我|私信我/g,
    suggest: () => "",
  },
];

export interface BannedOptions {
  /** 用户自己加的屏蔽词（命中算高风险，建议删除）。 */
  extraWords?: string[];
}

/** 返回所有命中（按出现位置排序，同一位置只算一次）。 */
export function checkBannedWords(text: string, opts: BannedOptions = {}): BannedHit[] {
  const hits = new Map<number, BannedHit>();
  for (const { kind, re, suggest } of RULES) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (m.index == null || hits.has(m.index)) continue;
      const word = m[0];
      hits.set(m.index, { word, kind, severity: BANNED_KIND_META[kind].severity, index: m.index, suggest: suggest?.(word) });
    }
  }
  for (const raw of opts.extraWords ?? []) {
    const w = raw.trim();
    if (!w) continue;
    for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) {
      if (!hits.has(i)) hits.set(i, { word: w, kind: "custom", severity: "high", index: i, suggest: "" });
    }
  }
  return [...hits.values()].sort((a, b) => a.index - b.index);
}

export interface BannedSummary {
  word: string;
  kind: BannedKind;
  severity: BannedSeverity;
  count: number;
  suggest?: string;
}

/** 汇总：同词合并计数，高风险排前，用于界面展示。 */
export function summarizeBanned(hits: BannedHit[]): BannedSummary[] {
  const m = new Map<string, BannedSummary>();
  for (const h of hits) {
    const cur = m.get(h.word);
    if (cur) cur.count++;
    else m.set(h.word, { word: h.word, kind: h.kind, severity: h.severity, count: 1, suggest: h.suggest });
  }
  return [...m.values()].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1));
}

/** 把文本里所有 word 换成建议（空串即删除）。没有建议的词不动。 */
export function applyBannedFix(text: string, word: string, suggest: string | undefined): string {
  if (suggest === undefined) return text;
  return text.split(word).join(suggest);
}

/** 一键处理：只处理有机械替换建议的词，其余留给用户自己改。 */
export function applyAllBannedFixes(text: string, opts: BannedOptions = {}): string {
  let out = text;
  for (const h of summarizeBanned(checkBannedWords(text, opts))) out = applyBannedFix(out, h.word, h.suggest);
  return out;
}

/** 平台硬限制（超了发不出去或被截断），不是软提示。 */
export const DRAFT_LIMITS = { title: 20, content: 1000, tags: 10 } as const;

export interface LimitIssue {
  field: "title" | "content" | "tags";
  message: string;
  used: number;
  max: number;
}

export function checkDraftLimits(d: { title: string; content: string; tags: string[] }): LimitIssue[] {
  const out: LimitIssue[] = [];
  const t = [...d.title].length;
  const c = [...d.content].length;
  if (t > DRAFT_LIMITS.title) out.push({ field: "title", message: "标题超过 20 字，发布会被截断或拒绝", used: t, max: DRAFT_LIMITS.title });
  if (c > DRAFT_LIMITS.content) out.push({ field: "content", message: "正文超过 1000 字", used: c, max: DRAFT_LIMITS.content });
  if (d.tags.length > DRAFT_LIMITS.tags) out.push({ field: "tags", message: "话题超过 10 个", used: d.tags.length, max: DRAFT_LIMITS.tags });
  return out;
}
