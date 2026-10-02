import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import type { CoverSpec } from "@v2media/shared";
import { renderCover } from "../src/lib/cover-render";
import { automaticCoverSpec } from "../src/lib/cover-spec";

const specs: CoverSpec[] = [
  { templateId: "poster", headline: "下班备餐不用赶", subtitle: "一晚准备好明天的三餐" },
  { templateId: "checklist", headline: "下班备餐做这3步", points: ["先分好食材", "按顺序准备", "分装留好标签"] },
  { templateId: "comparison", headline: "冰箱整理换个顺序", comparison: { left: "什么都堆在一起", right: "先分区再放食材" } },
  { templateId: "photo", headline: "给今晚留一点空闲", backgroundAssetId: 1 },
];

describe("中文模板封面（真实本地渲染，不依赖系统字体或网络）", () => {
  it("打包字体版本固定，附完整许可", async () => {
    const font = await readFile(new URL("../assets/fonts/NotoSansCJKsc-Bold.otf", import.meta.url));
    expect(createHash("sha256").update(font).digest("hex")).toBe("b5f0d1a190a7f9b43c310a8850630af12553df32c4c050543f9059732d9b4c0a");
    expect(await readFile(new URL("../assets/fonts/OFL.txt", import.meta.url), "utf8")).toContain("SIL OPEN FONT LICENSE");
  });
  it.each(specs)("$templateId 输出可解码的 1080×1440 PNG", async spec => {
    const photo = await sharp({ create: { width: 100, height: 200, channels: 3, background: "#638e75" } }).png().toBuffer();
    const bytes = await renderCover(spec, photo);
    const metadata = await sharp(bytes).metadata();
    expect(metadata).toMatchObject({ width: 1080, height: 1440, format: "png" });
    expect(bytes.length).toBeLessThan(10 * 1024 * 1024);
    const stats = await sharp(bytes).stats();
    expect(stats.channels.some(c => c.stdev > 10)).toBe(true); // A real composed image, not a blank colour.
  });
  it("长中文、中英混排、Pango 特殊字符按普通文字渲染", async () => {
    const bytes = await renderCover({ templateId: "poster", headline: "备餐&<自查> Meal Prep 一周安排，慢慢来", subtitle: "先分区\n再安排" });
    expect((await sharp(bytes).metadata()).width).toBe(1080);
  });
  it("缺必要输入拒绝渲染；自动选择缺证据时回退文字海报", async () => {
    await expect(renderCover({ templateId: "checklist", headline: "准备工作", points: ["只有一点"] })).rejects.toThrow();
    await expect(renderCover({ templateId: "photo", headline: "自己的照片", backgroundAssetId: 1 })).rejects.toThrow("底图不可用");
    expect(automaticCoverSpec("正文要点", "清单图", { points: ["先分区", "再准备"] }).templateId).toBe("checklist");
    expect(automaticCoverSpec("正文要点", "清单图").templateId).toBe("poster");
    expect(automaticCoverSpec("正文要点", "真人照").templateId).toBe("poster");
    expect(automaticCoverSpec("正文要点", "对比图", { comparison: { left: "一起放", right: "分区放" } }).templateId).toBe("comparison");
  });
});
