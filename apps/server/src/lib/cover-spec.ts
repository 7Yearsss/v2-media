import { z } from "zod";
import { COVER_TEMPLATES, type CoverSpec, type CoverTemplateId } from "@v2media/shared";

const plainText = (max: number) => z.string().trim().min(1).max(max)
  .refine(s => !/[\p{Extended_Pictographic}\u0000-\u0008\u000b\u000c\u000e-\u001f\u202a-\u202e\u2066-\u2069]/u.test(s), "请使用普通文字，暂不支持 emoji 或控制字符");
export const coverSpecSchema = z.object({
  templateVersion: z.literal(1).default(1),
  templateId: z.enum(["poster", "checklist", "comparison", "photo"]),
  headline: plainText(36),
  subtitle: plainText(48).optional(),
  points: z.array(plainText(28)).max(4).optional(),
  comparison: z.object({ left: plainText(40), right: plainText(40) }).optional(),
  backgroundAssetId: z.number().int().positive().optional(),
}).superRefine((spec, ctx) => {
  if (spec.templateId === "checklist" && (spec.points?.length ?? 0) < 2)
    ctx.addIssue({ code: "custom", message: "清单封面需要 2–4 个要点", path: ["points"] });
  if (spec.templateId === "comparison" && !spec.comparison)
    ctx.addIssue({ code: "custom", message: "对比封面需要两组文案", path: ["comparison"] });
  if (spec.templateId === "photo" && !spec.backgroundAssetId)
    ctx.addIssue({ code: "custom", message: "照片封面需要自己的底图", path: ["backgroundAssetId"] });
});

export function automaticCoverSpec(
  headline: string, referenceKind = "", details: Pick<CoverSpec, "points" | "comparison"> = {},
): CoverSpec {
  let templateId: CoverTemplateId = "poster";
  if (/清单|步骤|教程/.test(referenceKind) && (details.points?.length ?? 0) >= 2) templateId = "checklist";
  if (/对比|前后/.test(referenceKind) && details.comparison) templateId = "comparison";
  // Own photo is never inferred from a collected cover.
  const safeHeadline = Array.from(headline.replace(/[\p{Extended_Pictographic}\u200d\ufe0f\u0000-\u001f\u202a-\u202e\u2066-\u2069]/gu, "").trim()).slice(0, 36).join("") || "这篇笔记的要点";
  const preferred = coverSpecSchema.safeParse({ templateId, headline: safeHeadline, ...details });
  return preferred.success ? preferred.data : { templateVersion: 1, templateId: "poster", headline: safeHeadline };
}

export const coverTemplateName = (id: CoverTemplateId) => COVER_TEMPLATES.find(t => t.id === id)!.name;
