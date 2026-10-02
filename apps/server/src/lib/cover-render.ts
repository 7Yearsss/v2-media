import sharp, { type OverlayOptions } from "sharp";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import type { CoverSpec } from "@v2media/shared";
import { coverSpecSchema } from "./cover-spec";

export const COVER_RENDER_VERSION = 1;
const WIDTH = 1080, HEIGHT = 1440;
const FONT = fileURLToPath(new URL("../../assets/fonts/NotoSansCJKsc-Bold.otf", import.meta.url));
const COLOR = { paper: "#ffffff", ink: "#171717", red: "#a61f2b", line: "#dedede", gray: "#f2f2f2" };
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Explicit wrapping handles Chinese and long English tokens without system font fallbacks. */
export function wrapCoverText(text: string, units: number) {
  const lines: string[] = [];
  let line = "", used = 0;
  for (const ch of Array.from(text)) {
    if (ch === "\n") { lines.push(line); line = ""; used = 0; continue; }
    const width = /[\x00-\x7f]/.test(ch) ? 0.55 : 1;
    if (used + width > units && line) { lines.push(line.trimEnd()); line = ""; used = 0; }
    line += ch; used += width;
  }
  if (line) lines.push(line.trimEnd());
  return lines.join("\n");
}

async function textLayer(text: string, x: number, y: number, width: number, height: number, size: number, color: string, align: "left" | "center" = "left") {
  let fontSize = size;
  for (let i = 0; i < 8; i++) {
    const { data, info } = await sharp({ text: {
      text: `<span foreground="${color}">${escape(text)}</span>`,
      font: `Noto Sans CJK SC Bold ${Math.round(fontSize)}`, fontfile: FONT, rgba: true,
      dpi: 72, spacing: 10, align: align === "center" ? "centre" : "left",
    } }).png().toBuffer({ resolveWithObject: true });
    if (info.width <= width && info.height <= height) return {
      input: data, left: Math.round(x + (align === "center" ? (width - info.width) / 2 : 0)),
      top: Math.round(y + (height - info.height) / 2),
    };
    fontSize *= Math.min(width / info.width, height / info.height) * 0.95;
  }
  throw new Error("封面文字过长，请缩短后重新生成");
}
const rect = (x: number, y: number, w: number, h: number, fill: string, radius = 0, stroke?: string) =>
  `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${radius}" fill="${fill}"${stroke ? ` stroke="${stroke}" stroke-width="2"` : ""}/>`;
const svgLayer = (elements: string[]) => ({ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}">${elements.join("")}</svg>`), left: 0, top: 0 });

export async function renderCover(input: CoverSpec, background?: Buffer): Promise<Buffer> {
  await access(FONT).catch(() => { throw new Error("中文字体不可用，请部署字体文件后重试"); });
  const spec = coverSpecSchema.parse(input);
  const layers: OverlayOptions[] = [];
  let image = sharp({ create: { width: WIDTH, height: HEIGHT, channels: 3, background: COLOR.paper } });
  const count = Array.from(spec.headline).length;
  const posterUnits = spec.headline.includes("\n") ? 8 : Math.max(3, Math.ceil(count / Math.max(1, Math.ceil(count / 6))));
  const title = wrapCoverText(spec.headline, spec.templateId === "poster" ? posterUnits : 12);
  if (spec.templateId === "poster") {
    layers.push(svgLayer([rect(0, 0, WIDTH, 1120, COLOR.red), rect(72, 1174, 112, 8, COLOR.red)]));
    layers.push(await textLayer(title, 78, 146, 924, 850, 152, COLOR.paper));
    if (spec.subtitle) layers.push(await textLayer(wrapCoverText(spec.subtitle, 20), 78, 1220, 924, 148, 42, COLOR.ink));
  } else if (spec.templateId === "checklist") {
    const points = spec.points!;
    const cardHeight = Math.floor((900 - (points.length - 1) * 28) / points.length);
    const shapes = [rect(0, 0, WIDTH, 304, COLOR.red)];
    for (let i = 0; i < points.length; i++) shapes.push(rect(64, 356 + i * (cardHeight + 28), 952, cardHeight, COLOR.paper, 30, COLOR.line));
    layers.push(svgLayer(shapes));
    layers.push(await textLayer(title, 72, 42, 936, 220, 100, COLOR.paper));
    for (let i = 0; i < points.length; i++) {
      const y = 356 + i * (cardHeight + 28);
      layers.push(await textLayer(String(i + 1), 100, y + 30, 100, cardHeight - 60, 92, COLOR.red, "center"));
      layers.push(await textLayer(wrapCoverText(points[i]!, 11), 244, y + 26, 716, cardHeight - 52, 72, COLOR.ink));
    }
    if (spec.subtitle) layers.push(await textLayer(wrapCoverText(spec.subtitle, 22), 72, 1302, 936, 90, 36, COLOR.ink));
  } else if (spec.templateId === "comparison") {
    layers.push(svgLayer([rect(64, 424, 952, 392, COLOR.gray, 32), rect(64, 872, 952, 392, COLOR.red, 32)]));
    layers.push(await textLayer(title, 72, 64, 936, 296, 108, COLOR.ink));
    layers.push(await textLayer(wrapCoverText(spec.comparison!.left, 11), 112, 470, 856, 300, 82, COLOR.ink));
    layers.push(await textLayer(wrapCoverText(spec.comparison!.right, 11), 112, 918, 856, 300, 82, COLOR.paper));
    if (spec.subtitle) layers.push(await textLayer(wrapCoverText(spec.subtitle, 22), 72, 1316, 936, 80, 34, COLOR.ink));
  } else {
    if (!background) throw new Error("底图不可用，请重新选择自己的图片");
    image = sharp(background, { limitInputPixels: 40_000_000 }).rotate().resize(WIDTH, HEIGHT, { fit: "cover", position: "centre" });
    layers.push(svgLayer([rect(0, 992, WIDTH, 448, COLOR.paper), rect(0, 992, WIDTH, 8, COLOR.red)]));
    layers.push(await textLayer(title, 72, 1052, 936, spec.subtitle ? 236 : 316, 106, COLOR.ink));
    if (spec.subtitle) layers.push(await textLayer(wrapCoverText(spec.subtitle, 22), 72, 1320, 936, 72, 34, COLOR.ink));
  }
  return image.composite(layers).png().toBuffer();
}
