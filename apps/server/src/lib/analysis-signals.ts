import type { AnalysisSignals } from "@v2media/shared";

/** 信号层的输入：一篇笔记里算信号要用到的字段。 */
export interface SignalNote {
  ref: number;
  id?: number;
  title: string;
  type: string;
  authorName: string;
  likes: number;
  collects: number;
  comments: number;
  shares: number;
  tags: string[];
  content: string;
  hasDetail: boolean;
  publishedAt: Date | null;
  commentsData: unknown[];
}

export const engagementOf = (n: Pick<SignalNote, "likes" | "collects" | "comments" | "shares">) =>
  n.likes + n.collects + n.comments + n.shares;

const median = (xs: number[]) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const pct = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) : 0);

/** 标题钩子：规则可解释、可复现，AI 只解读它们的差异。 */
const HOOKS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "number", label: "数字", re: /\d/ },
  { key: "question", label: "疑问", re: /[？?]|怎么|如何|为什么|为啥|吗/ },
  { key: "contrast", label: "反差/避坑", re: /别|不要|千万|后悔|避雷|踩坑|翻车|再也不|难怪|原来|没想到|竟然/ },
  { key: "audience", label: "点名人群", re: /姐妹|宝子|打工人|学生党|新手|小白|宝妈|女生|男生|上班族|懒人/ },
  { key: "howto", label: "教程/清单", re: /教程|攻略|清单|合集|步骤|方法|公式|模板|必看|总结|干货/ },
  { key: "emotion", label: "强情绪", re: /绝了|爱了|炸了|救命|治愈|太[一-龥]{1,2}了|哭|离谱|封神/ },
];

/** 评论归类：规则粗分，AI 另外读样本提炼"没被满足的需求"。 */
const COMMENT_KINDS: Array<{ key: string; label: string; re: RegExp }> = [
  { key: "ask", label: "求资源/求做法", re: /链接|求|在哪|哪里|怎么(买|做|弄|用|办)|教程|同款|多少钱|价格|蹲|出处|品牌|型号/ },
  { key: "doubt", label: "质疑/吐槽", re: /假|骗|智商税|没用|踩雷|翻车|不行|难吃|难用|太贵|贵了|坑|恶心|垃圾|广告|营销/ },
  { key: "exp", label: "补充经验", re: /我(之前|以前|用过|试过|做过|吃过|买过)|亲测|实测|用了|试了|建议/ },
  { key: "like", label: "共鸣/夸赞", re: /我也|同感|太真实|哈哈|笑死|懂了?|泪目|好看|喜欢|爱了|绝|太[一-龥]{1,2}了/ },
];

type Cmt = { content?: string; likes?: number };

export function computeSignals(notes: SignalNote[], now: Date, opts: { videoRefs?: Set<number> } = {}): AnalysisSignals {
  const isVideo = (n: SignalNote) => n.type === "video" || !!opts.videoRefs?.has(n.ref);
  const byEng = [...notes].sort((a, b) => engagementOf(b) - engagementOf(a));
  const hitN = Math.max(1, Math.ceil(notes.length / 4));
  const hit = byEng.slice(0, hitN);
  const rest = byEng.slice(hitN);
  const hitSet = new Set(hit.map((n) => n.ref));

  // 1. 爆款 vs 其余的特征差
  // 藏/评只有进过详情页才采得到，没进的是 0 不是真 0：比率类特征只在有详情的笔记里比
  const feat = (f: (n: SignalNote) => number, only?: (n: SignalNote) => boolean) => {
    const h = only ? hit.filter(only) : hit;
    const r = only ? rest.filter(only) : rest;
    return [Math.round(median(h.map(f)) * 10) / 10, Math.round(median(r.map(f)) * 10) / 10] as const;
  };
  const rate = (a: number, b: number) => (b > 0 ? Math.min(3, a / b) : 0);
  const traits: AnalysisSignals["traits"] = [];
  const addTrait = (key: string, label: string, unit: string, f: (n: SignalNote) => number, only?: (n: SignalNote) => boolean) => {
    const [h, r] = feat(f, only);
    traits.push({ key, label, hit: h, rest: r, unit });
  };
  addTrait("titleLen", "标题字数", "字", (n) => [...n.title].length);
  const detailed = (n: SignalNote) => n.hasDetail;
  addTrait("saveRate", "藏赞比", "%", (n) => rate(n.collects, n.likes) * 100, detailed);
  addTrait("talkRate", "评赞比", "%", (n) => rate(n.comments, n.likes) * 100, detailed);
  addTrait("tags", "标签数", "个", (n) => n.tags.length);
  if (notes.some((n) => n.hasDetail)) addTrait("bodyLen", "正文字数", "字", (n) => [...n.content].length);
  traits.push({ key: "video", label: "视频占比", hit: pct(hit.map(isVideo)), rest: pct(rest.map(isVideo)), unit: "%" });

  // 2. 钩子：爆款里占比 + 带钩子 vs 不带 的中位互动倍数
  const hooks: AnalysisSignals["hooks"] = [];
  for (const h of HOOKS) {
    const withH = notes.filter((n) => h.re.test(n.title));
    if (!withH.length) continue;
    const without = notes.filter((n) => !h.re.test(n.title));
    const lift =
      withH.length >= 3 && without.length >= 3
        ? Math.round((median(withH.map(engagementOf)) / Math.max(1, median(without.map(engagementOf)))) * 10) / 10
        : null;
    hooks.push({
      key: h.key,
      label: h.label,
      count: withH.length,
      hitShare: pct(hit.map((n) => h.re.test(n.title))),
      lift,
      example: [...withH].sort((a, b) => engagementOf(b) - engagementOf(a))[0]!.title,
    });
  }
  hooks.sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0));

  // 3. 形式
  const formats: AnalysisSignals["formats"] = [];
  for (const type of ["image", "video"] as const) {
    const g = notes.filter((n) => isVideo(n) === (type === "video"));
    if (g.length) formats.push({ type, count: g.length, medianEngagement: Math.round(median(g.map(engagementOf))) });
  }

  // 4. 爆款发布时间（星期 / 小时，本地时区）
  const dated = hit.filter((n) => n.publishedAt);
  const timing =
    dated.length >= 3
      ? {
          byWeekday: Array.from({ length: 7 }, (_, d) => dated.filter((n) => n.publishedAt!.getDay() === d).length),
          byHour: Array.from({ length: 24 }, (_, h) => dated.filter((n) => n.publishedAt!.getHours() === h).length),
          samples: dated.length,
        }
      : null;

  // 5. 笔记类型：藏赞比 ≥ 0.5 = 工具收藏型；评赞比 ≥ 0.1 = 讨论型；其余 = 情绪点赞型
  const points: AnalysisSignals["points"] = byEng.filter((n) => n.hasDetail).slice(0, 40).map((n) => {
    const saveRate = rate(n.collects, n.likes);
    const talkRate = rate(n.comments, n.likes);
    return {
      ref: n.ref,
      id: n.id ?? 0,
      title: n.title,
      engagement: engagementOf(n),
      saveRate: Math.round(saveRate * 100) / 100,
      talkRate: Math.round(talkRate * 100) / 100,
      kind: saveRate >= 0.5 ? "tool" : talkRate >= 0.1 ? "talk" : "like",
    };
  });

  // 6. 评论归类
  const allComments = notes.flatMap((n) =>
    (Array.isArray(n.commentsData) ? (n.commentsData as Cmt[]) : [])
      .map((c) => ({ content: String(c?.content ?? ""), likes: Number(c?.likes ?? 0) }))
      .filter((c) => c.content),
  );
  let comments: AnalysisSignals["comments"] = null;
  if (allComments.length >= 5) {
    const buckets = new Map<string, { count: number; best: { content: string; likes: number } | null }>();
    for (const k of [...COMMENT_KINDS.map((k) => k.key), "other"]) buckets.set(k, { count: 0, best: null });
    for (const c of allComments) {
      const kind = COMMENT_KINDS.find((k) => k.re.test(c.content))?.key ?? "other";
      const b = buckets.get(kind)!;
      b.count++;
      if (!b.best || c.likes > b.best.likes) b.best = c;
    }
    comments = {
      total: allComments.length,
      categories: [...COMMENT_KINDS, { key: "other", label: "其他", re: /$^/ }]
        .map((k) => ({ key: k.key, label: k.label, count: buckets.get(k.key)!.count, sample: buckets.get(k.key)!.best?.content.slice(0, 60) ?? "" }))
        .filter((k) => k.count > 0)
        .sort((a, b) => b.count - a.count),
    };
  }

  // 7. 不可复制信号
  const traps: AnalysisSignals["traps"] = [];
  for (const n of hit) {
    if (n.publishedAt) {
      const days = Math.ceil((now.getTime() - n.publishedAt.getTime()) / 86_400_000);
      if (days > 365) traps.push({ ref: n.ref, title: n.title, reason: "old", detail: `发布 ${days} 天，总量是长期积累` });
    }
  }
  const byAuthor = new Map<string, SignalNote[]>();
  for (const n of hit) if (n.authorName) byAuthor.set(n.authorName, [...(byAuthor.get(n.authorName) ?? []), n]);
  for (const [author, g] of byAuthor) {
    if (g.length >= 3) traps.push({ ref: g[0]!.ref, title: g[0]!.title, reason: "author", detail: `${author} 占了爆款里的 ${g.length} 篇，可能靠账号势能` });
  }
  const hitMedian = median(hit.map(engagementOf));
  const top = hit[0];
  if (top && hit.length >= 4 && hitMedian > 0 && engagementOf(top) > hitMedian * 5) {
    traps.push({ ref: top.ref, title: top.title, reason: "outlier", detail: `互动是爆款中位数的 ${Math.round(engagementOf(top) / hitMedian)} 倍，单点爆款参考性弱` });
  }

  return {
    sample: {
      total: notes.length,
      hit: hit.length,
      withDetail: notes.filter((n) => n.hasDetail).length,
      withComments: notes.filter((n) => Array.isArray(n.commentsData) && n.commentsData.length > 0).length,
      videos: notes.filter(isVideo).length,
    },
    traits,
    hooks,
    formats,
    timing,
    points,
    comments,
    traps: traps.filter((t) => hitSet.has(t.ref)).slice(0, 6),
  };
}

/** 把信号压成给 AI 的紧凑文本（只给差异与结论，不给全量原始数据）。 */
export function signalsForPrompt(s: AnalysisSignals): string {
  const L: string[] = [];
  L.push(`样本：${s.sample.total} 篇，爆款（互动前25%）${s.sample.hit} 篇；进过详情 ${s.sample.withDetail}，有评论 ${s.sample.withComments}，视频 ${s.sample.videos}`);
  L.push("爆款 vs 其余（均值）：" + s.traits.map((t) => `${t.label} ${t.hit}${t.unit} vs ${t.rest}${t.unit}`).join("；"));
  if (s.hooks.length)
    L.push("标题钩子（爆款占比 / 带钩子的中位互动是不带的几倍）：" + s.hooks.map((h) => `${h.label} ${h.hitShare}% / ${h.lift ?? "样本不足"}倍（${h.count}篇）`).join("；"));
  if (s.formats.length > 1) L.push("形式中位互动：" + s.formats.map((f) => `${f.type === "video" ? "视频" : "图文"} ${f.medianEngagement}（${f.count}篇）`).join(" vs "));
  const kinds = { tool: 0, talk: 0, like: 0 };
  for (const p of s.points) kinds[p.kind]++;
  L.push(`爆款类型：工具收藏型 ${kinds.tool} / 讨论型 ${kinds.talk} / 情绪点赞型 ${kinds.like}`);
  if (s.comments) L.push(`评论 ${s.comments.total} 条分类：` + s.comments.categories.map((c) => `${c.label} ${c.count}`).join("，"));
  if (s.traps.length) L.push("不可复制信号：" + s.traps.map((t) => `#${t.ref} ${t.detail}`).join("；"));
  return L.join("\n");
}
