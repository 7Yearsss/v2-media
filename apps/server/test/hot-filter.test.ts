import { describe, expect, it } from "vitest";
import { normalizeHotFilter, passesHotFilter } from "@v2media/shared";
import { noteCardFromItem } from "@v2media/shared/xhs-parse";

describe("自动采集点赞规则", () => {
  it("旧设置缺省不筛选，启用后包含门槛边界", () => {
    expect(passesHotFilter(0)).toBe(true);
    for (const [likes, expected] of [[999, false], [1000, true], [1001, true]] as const)
      expect(passesHotFilter(likes, { enabled: true, minLikes: 1000 })).toBe(expected);
  });
  it("损坏阈值恢复默认，不因 NaN 放行", () => {
    for (const minLikes of [-1, NaN, Infinity, 1.5])
      expect(normalizeHotFilter({ enabled: true, minLikes }).minLikes).toBe(1000);
    expect(passesHotFilter(NaN, { enabled: true, minLikes: 0 })).toBe(false);
    expect(passesHotFilter(0, { enabled: true, minLikes: 0 })).toBe(true);
  });
  it("站点的万单位先归一化再判断门槛", () => {
    const card = noteCardFromItem({ id: "hot", note_card: { interact_info: { liked_count: "1.2万" } } }, "homefeed");
    expect(card?.likes).toBe(12000);
    expect(passesHotFilter(card!.likes, { enabled: true, minLikes: 12000 })).toBe(true);
  });
});
