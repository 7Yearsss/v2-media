import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RotateCcw, Sparkles } from "lucide-react";
import { COVER_TEMPLATES, checkBannedWords, type CoverSpec, type CoverTemplateId } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { api, captureSession } from "@/lib/api";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

function TemplateSymbol({ id }: { id: CoverTemplateId }) {
  return <span aria-hidden className="flex h-10 w-7 shrink-0 flex-col overflow-hidden rounded border border-current/25 bg-white text-[#a61f2b]">
    {id === "poster" ? <span className="flex h-8 items-center justify-center bg-[#a61f2b] text-[9px] font-bold text-white">大字</span> :
      id === "checklist" ? <><span className="h-2 bg-[#a61f2b]" />{[1, 2, 3].map(i => <span key={i} className="mx-1 mt-1 h-1 border-b border-[#a61f2b]/50" />)}</> :
      id === "comparison" ? <><span className="m-1 h-3 bg-[#dedede]" /><span className="mx-1 h-3 bg-[#a61f2b]" /></> :
      <><span className="h-7 bg-[#638e75]" /><span className="m-1 border-b border-[#a61f2b]" /></>}
  </span>;
}

export function DraftCover({ draftId, beforeGenerate }: { draftId: number; beforeGenerate: () => Promise<boolean> }) {
  const client = useQueryClient();
  const toast = useToast();
  const session = useMemo(() => captureSession(), []);
  const query = useQuery({ queryKey: ["draft-media", draftId], queryFn: () => api.draft(draftId) });
  const draft = query.data;
  const [template, setTemplate] = useState<CoverTemplateId>("poster");
  const [headline, setHeadline] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [points, setPoints] = useState("");
  const [left, setLeft] = useState("");
  const [right, setRight] = useState("");
  const [background, setBackground] = useState("");
  const [sending, setSending] = useState(false);
  const specKey = JSON.stringify(draft?.coverSpec);
  useEffect(() => {
    const spec = draft?.coverSpec;
    if (!draft) return;
    setTemplate(spec?.templateId ?? "poster");
    setHeadline(spec?.headline ?? Array.from(draft.title).slice(0, 36).join(""));
    setSubtitle(spec?.subtitle ?? "");
    setPoints((spec?.points ?? []).join("\n"));
    setLeft(spec?.comparison?.left ?? ""); setRight(spec?.comparison?.right ?? "");
    setBackground(spec?.backgroundAssetId ? String(spec.backgroundAssetId) : "");
  }, [draft?.id, draft?.coverRevision, specKey]);
  const writing = !!draft && ["queued", "writing"].includes(draft.generationState);
  const rendering = !!draft && ["queued", "processing"].includes(draft.coverState);
  const ownPhotos = draft?.uploads?.filter(a => a.kind === "upload" && a.status === "ready") ?? [];
  const pendingSpec: CoverSpec = {
    templateId: template, headline: headline.trim(), ...(subtitle.trim() ? { subtitle: subtitle.trim() } : {}),
    ...(template === "checklist" ? { points: points.split("\n").map(p => p.trim()).filter(Boolean) } : {}),
    ...(template === "comparison" ? { comparison: { left: left.trim(), right: right.trim() } } : {}),
    ...(template === "photo" && background ? { backgroundAssetId: Number(background) } : {}),
  };
  const warnings = checkBannedWords([headline, subtitle, points, left, right].join("\n"));
  const generate = async () => {
    if (!draft || sending || writing) return;
    setSending(true);
    try {
      if (!(await beforeGenerate())) { toast.error("文字尚未保存，请先重试保存"); return; }
      const result = await api.generateCover(draftId, { spec: pendingSpec, revision: draft.coverRevision }, session);
      client.setQueryData(["draft-media", draftId], result.draft);
      void client.invalidateQueries({ queryKey: ["drafts"] });
      toast.success("封面已进入生成队列");
    } catch (e) { toast.error("封面生成失败", e instanceof Error ? e.message : undefined); void query.refetch(); }
    finally { setSending(false); }
  };
  const retry = async () => {
    if (sending) return;
    setSending(true);
    try {
      if (!(await beforeGenerate())) { toast.error("文字尚未保存，请先重试保存"); return; }
      const result = await api.retryGeneration(draftId, session);
      client.setQueryData(["draft-media", draftId], result.draft);
      void client.invalidateQueries({ queryKey: ["drafts"] });
      toast.success("开始重新成稿");
    } catch (e) { toast.error("重新成稿失败", e instanceof Error ? e.message : undefined); }
    finally { setSending(false); }
  };
  if (!draft) return null;
  return <section aria-label="封面编辑" className="space-y-3 rounded-xl border border-border p-4">
    <div className="flex items-center justify-between gap-2">
      <p className="flex items-center gap-1.5 text-sm font-medium"><Sparkles className="size-4 text-primary" />封面</p>
      <span aria-live="polite" className="flex items-center gap-1 text-xs text-muted-foreground">
        {(writing || rendering) && <Loader2 className="size-3 animate-spin" />}
        {writing ? draft.generationState === "writing" ? "正在写正文" : "等待成稿" : rendering ? "正在生成封面" : draft.coverState === "ready" ? "封面已生成" : "1080 × 1440"}
      </span>
    </div>
    {writing && <p className="text-xs leading-5 text-muted-foreground">成稿完成后会自动带一张封面。此时编辑正文会保留你的修改并停止覆盖。</p>}
    {draft.generationState === "failed" && <div role="alert" className="space-y-2 rounded-lg bg-destructive/5 p-3 text-xs text-destructive">
      <p>{draft.generationError}</p><Button size="sm" variant="outline" onClick={() => void retry()} disabled={sending}><RotateCcw className="size-3" />重新成稿（覆盖当前文字）</Button>
    </div>}
    {!!draft.generationWarnings?.length && <p className="text-xs text-amber-600">成稿自查需留意：{draft.generationWarnings.map(w => w.word).join("、")}</p>}
    {draft.coverError && <p role="alert" className="rounded-lg bg-destructive/5 p-3 text-xs text-destructive">{draft.coverError}{draft.coverAssetId && draft.images.some(i => i.assetId === draft.coverAssetId && i.url) ? "，当前封面仍保留。" : ""}</p>}
    {!writing && <>
      <div className="grid grid-cols-2 gap-2">
        {COVER_TEMPLATES.map(t => <button key={t.id} type="button" aria-pressed={template === t.id} onClick={() => setTemplate(t.id)}
          className={cn("flex items-center gap-2 rounded-lg border px-3 py-2 text-left text-xs transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary",
            template === t.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted")}>
          <TemplateSymbol id={t.id} /><span>{t.name}</span>
        </button>)}
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground"><span>封面文字 · 36 字</span>
        <textarea aria-label="封面大字" value={headline} onChange={e => setHeadline(e.target.value)} maxLength={36} rows={2}
          className="w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
      </label>
      <Input value={subtitle} onChange={setSubtitle} placeholder="底部一句话（可选）" aria-label="封面补充文字" />
      {template === "checklist" && <label className="block space-y-1 text-xs text-muted-foreground"><span>要点 · 每行一条</span>
        <textarea aria-label="封面要点" rows={3} value={points} onChange={e => setPoints(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none focus:border-primary" />
      </label>}
      {template === "comparison" && <div className="grid grid-cols-2 gap-2">
        <Input value={left} onChange={setLeft} placeholder="对比一侧" aria-label="对比一侧" />
        <Input value={right} onChange={setRight} placeholder="对比另一侧" aria-label="对比另一侧" />
      </div>}
      {template === "photo" && <label className="block space-y-1 text-xs text-muted-foreground"><span>自己的底图</span>
        <select aria-label="封面底图" value={background} onChange={e => setBackground(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground">
          <option value="">选择已上传的图片</option>{ownPhotos.map(a => <option key={a.id} value={a.id}>{a.filename}</option>)}
        </select>{!ownPhotos.length && <span>先在下方上传一张自己的图片，再选择底图。</span>}
      </label>}
      {!!warnings.length && <p className="text-xs text-amber-600">封面自查需留意：{[...new Set(warnings.map(w => w.word))].join("、")}</p>}
      <Button size="sm" variant="outline" onClick={() => void generate()} disabled={sending || !headline.trim()}>
        {sending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
        {rendering ? "按新参数重新生成" : draft.coverAssetId ? "重新生成封面" : "生成封面"}
      </Button>
      <p className="text-[11px] leading-5 text-muted-foreground">生成后用作首图</p>
    </>}
  </section>;
}
