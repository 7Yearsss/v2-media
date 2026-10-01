/**
 * 小红书发布前违禁词检测（纯函数，前后端共用）。
 * 规则按平台公开的限流/违规类型整理，宁可提示不要漏：命中只是提醒，不阻止发布。
 */

export type BannedKind = "extreme" | "medical" | "contact" | "promise" | "bait";

export interface BannedHit {
  word: string;
  kind: BannedKind;
  /** 在文本里的起始位置。 */
  index: number;
}

export const BANNED_KIND_META: Record<BannedKind, { label: string; hint: string }> = {
  extreme: { label: "极限用语", hint: "广告法禁用，换成具体数据或体验" },
  medical: { label: "医疗功效", hint: "不能承诺疗效，改成个人体验" },
  contact: { label: "站外导流", hint: "留联系方式/外链会被限流" },
  promise: { label: "夸大承诺", hint: "保证/暴富类承诺会被判营销" },
  bait: { label: "诱导互动", hint: "求赞求关注类会被降权" },
};

const RULES: Array<{ kind: BannedKind; re: RegExp }> = [
  { kind: "extreme", re: /最(好|佳|强|低价?|便宜|大|优|快|高级|有效|划算|先进|专业)|第一|顶级|顶尖|绝对|唯一|首选|万能|全网最|史上|秒杀|销量冠军|国家级|世界级|极致|无敌/g },
  { kind: "medical", re: /根治|治愈|治疗|疗效|药到病除|包治|消炎|抗癌|速效|立竿见影|排毒|\d+天(瘦|减|白|祛|消)\S{0,3}/g },
  { kind: "contact", re: /微信|薇信|威信|\bvx\b|v信|加我|二维码|扫码|公众号|淘宝|拼多多|手机号|1[3-9]\d{9}|点击链接|\bQQ\b/gi },
  { kind: "promise", re: /保证|稳赚|日入|月入(过)?[万千]|躺赚|暴富|包过|零风险|无副作用/g },
  { kind: "bait", re: /求赞|求关注|互关|互赞|互粉|点赞收藏必看|不转不是/g },
];

/** 返回所有命中（按出现位置排序，同一位置只算一次）。 */
export function checkBannedWords(text: string): BannedHit[] {
  const hits = new Map<number, BannedHit>();
  for (const { kind, re } of RULES) {
    for (const m of text.matchAll(new RegExp(re.source, re.flags))) {
      if (m.index == null || hits.has(m.index)) continue;
      hits.set(m.index, { word: m[0], kind, index: m.index });
    }
  }
  return [...hits.values()].sort((a, b) => a.index - b.index);
}

/** 汇总：同词合并计数，用于界面展示。 */
export function summarizeBanned(hits: BannedHit[]): Array<{ word: string; kind: BannedKind; count: number }> {
  const m = new Map<string, { word: string; kind: BannedKind; count: number }>();
  for (const h of hits) {
    const cur = m.get(h.word);
    if (cur) cur.count++;
    else m.set(h.word, { word: h.word, kind: h.kind, count: 1 });
  }
  return [...m.values()];
}
