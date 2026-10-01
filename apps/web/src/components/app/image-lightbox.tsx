import { ChevronLeft, ChevronRight, ExternalLink, X, ZoomIn, ZoomOut } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EASE_OUT } from "@/lib/ease";
import { cn } from "@/lib/utils";

/**
 * 站内图片放大查看（评论图片、笔记大图用）：遮罩 + 居中大图，
 * Esc / 点遮罩关闭，←/→ 切换，点图片在「适应」和「放大」间切换（放大时跟随指针平移）。
 * 键盘事件在捕获阶段拦掉，避免 Esc 同时关掉底下的笔记详情。
 */
export function ImageLightbox({
  images,
  index,
  onIndexChange,
  onClose,
}: {
  /** 已是可直接访问的地址（过 mediaUrl 之后）。null = 关闭。 */
  images: string[] | null;
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
}) {
  const open = images !== null && images.length > 0;
  const count = images?.length ?? 0;
  const [zoomed, setZoomed] = useState(false);
  const [origin, setOrigin] = useState({ x: 50, y: 50 });
  const [failed, setFailed] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);
  const latest = useRef({ index, count, onIndexChange, onClose });
  latest.current = { index, count, onIndexChange, onClose };

  // 换图 / 重新打开：回到适应大小
  useEffect(() => {
    setZoomed(false);
    setFailed(false);
  }, [index, images]);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement;
    closeRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      const { index: i, count: n, onIndexChange: go, onClose: close } = latest.current;
      let handled = true;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(Math.max(0, i - 1));
      else if (e.key === "ArrowRight") go(Math.min(n - 1, i + 1));
      else if (e.key === "j" || e.key === "k") { /* 不让详情的上一条/下一条在放大时生效 */ }
      else handled = false;
      if (handled) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true });
    };
  }, [open]);

  const src = images?.[index];
  const nav = "absolute top-1/2 z-10 grid size-11 -translate-y-1/2 place-items-center rounded-full bg-white/10 text-white outline-none backdrop-blur-sm transition-colors hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white disabled:pointer-events-none disabled:opacity-25 active:scale-95";

  return createPortal(
    open && src ? (
        <motion.div
          key="lightbox"
          role="dialog"
          aria-modal="true"
          aria-label="图片查看"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.18, ease: EASE_OUT }}
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/85 backdrop-blur-sm"
          onClick={onClose}
        >
          <div className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-2 p-3 text-white" onClick={(e) => e.stopPropagation()}>
            <span className="rounded-full bg-white/10 px-3 py-1 text-xs tabular-nums backdrop-blur-sm" aria-live="polite">
              {index + 1} / {count}
            </span>
            <div className="flex items-center gap-1">
              <button type="button" aria-label={zoomed ? "缩小" : "放大"} onClick={() => setZoomed((z) => !z)} className="grid size-10 place-items-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white">
                {zoomed ? <ZoomOut className="size-5" /> : <ZoomIn className="size-5" />}
              </button>
              <a href={src} target="_blank" rel="noreferrer" aria-label="在新标签页打开原图" title="在新标签页打开原图" className="grid size-10 place-items-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white">
                <ExternalLink className="size-5" />
              </a>
              <button ref={closeRef} type="button" aria-label="关闭" onClick={onClose} className="grid size-10 place-items-center rounded-full outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white">
                <X className="size-5" />
              </button>
            </div>
          </div>

          {count > 1 ? (
            <>
              <button type="button" aria-label="上一张" disabled={index === 0} onClick={(e) => { e.stopPropagation(); onIndexChange(index - 1); }} className={cn(nav, "left-3")}><ChevronLeft className="size-6" /></button>
              <button type="button" aria-label="下一张" disabled={index === count - 1} onClick={(e) => { e.stopPropagation(); onIndexChange(index + 1); }} className={cn(nav, "right-3")}><ChevronRight className="size-6" /></button>
            </>
          ) : null}

          {failed ? (
            <p className="text-sm text-white/80" onClick={(e) => e.stopPropagation()}>图片加载失败</p>
          ) : (
            <img
              key={src}
              src={src}
              alt={`图片 ${index + 1} / ${count}`}
              draggable={false}
              onError={() => setFailed(true)}
              onClick={(e) => {
                e.stopPropagation();
                const rect = e.currentTarget.getBoundingClientRect();
                setOrigin({ x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 });
                setZoomed((z) => !z);
              }}
              onPointerMove={(e) => {
                if (!zoomed) return;
                const rect = e.currentTarget.getBoundingClientRect();
                setOrigin({ x: ((e.clientX - rect.left) / rect.width) * 100, y: ((e.clientY - rect.top) / rect.height) * 100 });
              }}
              className={cn(
                "max-h-[88vh] max-w-[92vw] select-none rounded-2xl object-contain shadow-2xl transition-transform duration-200",
                zoomed ? "cursor-zoom-out" : "cursor-zoom-in",
              )}
              style={{ transform: zoomed ? "scale(2.2)" : "scale(1)", transformOrigin: `${origin.x}% ${origin.y}%` }}
            />
          )}
        </motion.div>
    ) : null,
    document.body,
  );
}
