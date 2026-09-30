import type { CollectedNote } from "@v2media/shared";
import { formatCount } from "@/lib/format";

/** 已加载笔记少于这个数时不判"高赞"，样本太小没有参照意义。 */
const MIN_SAMPLE = 10;
const HOT_PERCENTILE = 0.9;

type StatField = "collects" | "comments" | "shares";

/** 笔记是否收过详情：老数据没有 hasDetail 字段时以有发布时间兜底。 */
export function hasDetail(note: CollectedNote): boolean {
  return note.hasDetail ?? Boolean(note.publishedAt);
}

/**
 * 收藏/评论/分享只有详情页才有：没采过详情且值为 0 时是"未采到"而不是真的 0，
 * 显示「—」。点赞列表页就有，始终按数字显示。
 */
export function statLabel(note: CollectedNote, field: StatField): string {
  const value = note[field];
  return value === 0 && !hasDetail(note) ? "—" : formatCount(value);
}

/** 当前已加载笔记的「高赞」门槛（点赞前 10%）；样本不足或全为 0 返回 null。 */
export function hotThreshold(notes: CollectedNote[]): number | null {
  if (notes.length < MIN_SAMPLE) return null;
  const sorted = notes.map((n) => n.likes).sort((a, b) => a - b);
  const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * HOT_PERCENTILE))];
  return value > 0 ? value : null;
}

export interface NoteBadge {
  key: string;
  label: string;
  hint: string;
}

/** 卡片上的判断标签：点赞进入已加载前 10% → 高赞；收藏 ≥ 点赞一半且已采详情 → 干货型。 */
export function noteBadges(note: CollectedNote, threshold: number | null): NoteBadge[] {
  const badges: NoteBadge[] = [];
  if (threshold !== null && note.likes >= threshold) {
    badges.push({
      key: "hot",
      label: "高赞",
      hint: `点赞 ${formatCount(note.likes)}，位于当前已加载笔记的前 10%（≥ ${formatCount(threshold)}）`,
    });
  }
  if (hasDetail(note) && note.likes >= 100 && note.collects / note.likes >= 0.5) {
    badges.push({
      key: "saved",
      label: "干货型",
      hint: `收藏 ${formatCount(note.collects)} ≥ 点赞的一半，用户倾向于先收藏再看`,
    });
  }
  return badges;
}
