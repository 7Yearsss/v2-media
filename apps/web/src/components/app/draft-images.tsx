import { ArrowLeft, ArrowRight, ImagePlus, Loader2, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { IMAGE_UPLOAD_LIMITS, type Draft, type NoteImage } from "@v2media/shared";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { api, ApiError, mediaUrl } from "@/lib/api";
import { useToast } from "@/lib/toast";

export function DraftImages({ draftId, onImagesChange, onDraftChange }: {
  draftId: number; onImagesChange: (draftId: number, images: NoteImage[]) => void;
  onDraftChange?: (draft: Draft) => void;
}) {
  const client = useQueryClient();
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const key = ["draft-media", draftId] as const;
  const query = useQuery({
    queryKey: key, queryFn: () => api.draft(draftId),
    refetchInterval: q => {
      const d = q.state.data;
      return d && (["queued", "writing"].includes(d.generationState) || ["queued", "processing"].includes(d.coverState)
        || d.uploads?.some(a => a.status === "queued" || a.status === "processing")) ? 2000 : false;
    },
  });
  const draft = query.data;
  const images = draft?.images ?? [];
  const changeRef = useRef(onImagesChange);
  changeRef.current = onImagesChange;
  const draftChangeRef = useRef(onDraftChange);
  draftChangeRef.current = onDraftChange;
  useEffect(() => {
    if (draft) { changeRef.current(draftId, draft.images); draftChangeRef.current?.(draft); }
  }, [draft, draftId]);
  const accept = useCallback((next: Draft) => {
    client.setQueryData(["draft-media", next.id], next);
    void client.invalidateQueries({ queryKey: ["drafts"] });
  }, [client]);
  const fail = (e: unknown) => {
    toast.error("图片操作失败", e instanceof Error ? e.message : undefined);
    void client.invalidateQueries({ queryKey: key });
  };

  const saveImages = async (next: NoteImage[]) => {
    if (!draft || busy) return;
    setBusy(true);
    try { accept(await api.updateDraft(draftId, { images: next, imagesVersion: draft.imagesVersion })); }
    catch (e) { fail(e); }
    finally { if (mounted.current) setBusy(false); }
  };
  const addUrl = () => {
    const value = url.trim();
    if (!/^https?:\/\//.test(value)) { toast.error("请输入 http(s) 图片链接"); return; }
    if (images.length >= IMAGE_UPLOAD_LIMITS.images) { toast.error("每篇草稿最多 9 张图片"); return; }
    void saveImages([...images, { url: value }]);
    setUrl("");
  };
  const upload = async (files: File[]) => {
    if (busy || !draft) return;
    if (files.length + images.length > IMAGE_UPLOAD_LIMITS.images) { toast.error("每篇草稿最多 9 张图片"); return; }
    if (files.some(f => !f.size || f.size > IMAGE_UPLOAD_LIMITS.bytes || !["image/jpeg", "image/png", "image/webp"].includes(f.type))) {
      toast.error("请选择 10MiB 以内的 JPEG、PNG 或 WebP 图片"); return;
    }
    setBusy(true);
    try {
      // Sequential acceptance reserves the user's selection order. Server processing is asynchronous.
      let current = await api.draft(draftId);
      for (const file of files) {
        if (!mounted.current) break;
        const uploadId = crypto.randomUUID();
        try { current = (await api.uploadImage(draftId, current.imagesVersion, file, uploadId)).draft; }
        catch (e) {
          if (!(e instanceof ApiError) || e.status !== 409) throw e;
          // Worker completion may advance version while the next upload request is being sent.
          current = await api.draft(draftId);
          current = (await api.uploadImage(draftId, current.imagesVersion, file, uploadId)).draft;
        }
        accept(current);
      }
    } catch (e) { fail(e); }
    finally { if (mounted.current) setBusy(false); }
  };
  const move = (index: number, delta: number) => {
    const next = [...images];
    [next[index], next[index + delta]] = [next[index + delta]!, next[index]!];
    void saveImages(next);
  };
  return <div>
    <div className="mb-2 flex items-center justify-between">
      <p className="text-xs font-medium text-muted-foreground">图片（{images.length}/{IMAGE_UPLOAD_LIMITS.images}）</p>
      {busy && <span className="flex items-center gap-1 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />正在保存图片</span>}
    </div>
    {query.isError && <p role="alert" className="mb-2 text-xs text-destructive">图片加载失败 <button onClick={() => void query.refetch()} className="underline">重试</button></p>}
    <div className="grid grid-cols-3 gap-2">
      {images.map((image, index) => {
        const asset = draft?.uploads?.find(a => a.id === image.assetId);
        return <div key={image.assetId ?? image.url + index} className="relative overflow-hidden rounded-xl border border-border bg-muted">
          <div className="flex aspect-square items-center justify-center">
            {image.url ? <img src={mediaUrl(image.url)} alt={`图 ${index + 1}`} className="size-full object-cover" /> :
              <div className="px-2 text-center text-xs text-muted-foreground">
                {asset?.status === "failed" ? <span className="text-destructive">{asset.kind === "cover" ? "封面生成失败" : "上传失败"}</span> : <><Loader2 className="mx-auto mb-1 size-4 animate-spin" />{asset?.kind === "cover" ? "正在生成封面" : asset?.status === "processing" ? "正在处理" : "等待处理"}</>}
                <p className="mt-1 line-clamp-2 break-all">{asset?.filename ?? "图片"}</p>
              </div>}
          </div>
          <button type="button" aria-label={`删除图 ${index + 1}`} disabled={busy} onClick={() => void saveImages(images.filter((_, i) => i !== index))}
            className="absolute right-1 top-1 grid size-6 place-items-center rounded-full bg-black/60 text-white disabled:opacity-40"><X className="size-3.5" /></button>
          <div className="flex items-center justify-between px-1 py-1">
            <button aria-label={`图 ${index + 1} 前移`} disabled={busy || index === 0} onClick={() => move(index, -1)} className="grid size-6 place-items-center rounded hover:bg-background disabled:opacity-30"><ArrowLeft className="size-3.5" /></button>
            <span className="text-[10px] text-muted-foreground">{index === 0 ? "封面" : `图 ${index + 1}`}</span>
            <button aria-label={`图 ${index + 1} 后移`} disabled={busy || index === images.length - 1} onClick={() => move(index, 1)} className="grid size-6 place-items-center rounded hover:bg-background disabled:opacity-30"><ArrowRight className="size-3.5" /></button>
          </div>
          {asset?.status === "failed" && <div className="px-2 pb-2 text-[10px] text-destructive">
            <p className="break-words">{asset?.error}</p>
            {asset.kind === "cover" ? <p className="mt-1">请在封面编辑区重新生成</p> : <button disabled={busy} onClick={async () => {
              setBusy(true);
              try { await api.retryImage(asset!.id); await query.refetch(); }
              catch (e) { fail(e); } finally { if (mounted.current) setBusy(false); }
            }} className="mt-1 flex items-center gap-1 underline"><RotateCcw className="size-3" />重试上传</button>}
          </div>}
        </div>;
      })}
    </div>
    <input ref={picker} type="file" accept="image/jpeg,image/png,image/webp" multiple className="hidden" aria-label="选择本地图片"
      onChange={e => { void upload(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
    <button type="button" disabled={busy || !draft || images.length >= IMAGE_UPLOAD_LIMITS.images} onClick={() => picker.current?.click()}
      onDragOver={e => { e.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)}
      onDrop={e => { e.preventDefault(); setDragging(false); void upload(Array.from(e.dataTransfer.files)); }}
      className={`mt-2 flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-3 py-4 text-xs disabled:opacity-50 ${dragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"}`}>
      <ImagePlus className="size-4" /><span>点击选择或拖放图片</span>
      <span className="text-[10px] text-muted-foreground">JPEG / PNG / WebP · 单张最多 10MiB</span>
    </button>
    <div className="mt-2 flex gap-2">
      <Input value={url} onChange={setUrl} placeholder="或粘贴图片 URL…"
        onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); addUrl(); } }} className="flex-1"
        classNames={{ field: "h-8", input: "pl-3 pr-3 text-xs" }} />
      <Button size="sm" variant="outline" onClick={addUrl} disabled={busy || !draft || !url.trim() || images.length >= IMAGE_UPLOAD_LIMITS.images}>添加</Button>
    </div>
  </div>;
}
