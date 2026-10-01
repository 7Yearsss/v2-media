import {
  applyAllBannedFixes,
  checkBannedWords,
  checkDraftLimits,
  summarizeBanned,
} from "@v2media/shared";
import { describe, expect, it } from "vitest";

const words = (t: string) => checkBannedWords(t).map((h) => h.word);

describe("违禁词：不误伤正常说法", () => {
  it.each([
    "第一次练臀腿别慌",
    "第一步先热身，第二步再主项",
    "第一天打卡",
    "第一个动作是深蹲",
    "第一时间告诉你",
    "最后问你一遍 那个前刺你删不删",
    "今天练背，感觉不错",
    "我最近在练腿",
  ])("%s", (t) => {
    expect(words(t)).toEqual([]);
  });
});

describe("违禁词：该抓的要抓到", () => {
  it("极限用语：宣称式的“第一”和“最X”", () => {
    expect(words("全网最低价")).toContain("全网最");
    expect(words("销量第一的品牌")).toContain("销量第一");
    expect(words("这个最好用")).toContain("最好");
    expect(words("顶级配置，绝对值得")).toEqual(expect.arrayContaining(["顶级", "绝对"]));
  });

  it("医疗功效 / 夸大承诺 / 诱导互动", () => {
    expect(words("7天瘦10斤，根治失眠")).toEqual(expect.arrayContaining(["根治"]));
    expect(words("保证月入过万")).toEqual(expect.arrayContaining(["保证", "月入过万"]));
    expect(words("求赞求关注，互粉")).toEqual(expect.arrayContaining(["求赞", "求关注", "互粉"]));
  });

  it("站外导流：含拆字/夹符号/谐音变体", () => {
    for (const t of ["加我微信", "加我 微 信", "薇.信聊", "v x 私聊", "V-X", "威信号", "手机 13812345678", "扫码进群", "点击链接购买"]) {
      expect(checkBannedWords(t).some((h) => h.kind === "contact"), t).toBe(true);
    }
    // “vx” 夹在英文单词里不算
    expect(words("review 之后")).toEqual([]);
  });
});

describe("违禁词：严重度与建议", () => {
  it("导流/功效/承诺/诱导 = high，极限用语 = low；高风险排前", () => {
    const s = summarizeBanned(checkBannedWords("这个最好用，微信联系"));
    expect(s.map((x) => [x.word, x.severity])).toEqual([
      ["微信", "high"],
      ["最好", "low"],
    ]);
  });

  it("给替换建议；导流类建议删除（空串）；没有机械替换的是 undefined", () => {
    const h = (t: string) => checkBannedWords(t)[0]!;
    expect(h("最好").suggest).toBe("很好");
    expect(h("加我").suggest).toBe("");
    expect(h("日入过千").suggest).toBeUndefined();
  });

  it("一键处理：只改有建议的词，其余保持原样", () => {
    expect(applyAllBannedFixes("这个最好用，扫码加我，日入过千")).toBe("这个很好用，，日入过千");
  });
});

describe("平台硬限制", () => {
  it("标题 > 20 字 / 正文 > 1000 字 / 话题 > 10 个", () => {
    expect(checkDraftLimits({ title: "短标题", content: "正文", tags: ["a"] })).toEqual([]);
    const issues = checkDraftLimits({ title: "字".repeat(21), content: "字".repeat(1001), tags: Array(11).fill("t") });
    expect(issues.map((i) => i.field)).toEqual(["title", "content", "tags"]);
    // 按字符数而不是 UTF-16 长度：emoji 算 1
    expect(checkDraftLimits({ title: "😀".repeat(20), content: "", tags: [] })).toEqual([]);
  });
});
