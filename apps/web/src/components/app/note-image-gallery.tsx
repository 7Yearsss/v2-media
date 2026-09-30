import { ChevronLeft, ChevronRight, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { mediaUrl } from "@/lib/api";
import { cn } from "@/lib/utils";

export function NoteImageGallery({ images }: { images: { url: string }[] }) {
  const trackRef = useRef<HTMLDivElement>(null);
  const indexRef = useRef(0);
  const destination = useRef<number | null>(null);
  const drag = useRef<{ id: number; x: number; left: number; index: number } | null>(null);
  const [index, setIndex] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [ratios, setRatios] = useState<Record<string, number>>({});
  const reduceMotion = useReducedMotion();
  const current = Math.min(index, images.length - 1);

  function goTo(next: number, instant = false) {
    const track = trackRef.current;
    if (!track) return;
    const target = Math.max(0, Math.min(images.length - 1, next));
    indexRef.current = target;
    destination.current = target;
    setIndex(target);
    track.scrollTo({ left: target * track.clientWidth, behavior: instant || reduceMotion ? "instant" : "smooth" });
  }

  useEffect(() => {
    const track = trackRef.current;
    if (!track) return;
    let previousWidth = track.clientWidth;
    const observer = new ResizeObserver(() => {
      if (track.clientWidth === previousWidth) return;
      previousWidth = track.clientWidth;
      destination.current = null;
      track.scrollTo({ left: indexRef.current * track.clientWidth, behavior: "instant" });
    });
    observer.observe(track);
    return () => observer.disconnect();
  }, []);

  const arrowClass = "absolute top-1/2 z-10 grid size-10 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white outline-none transition-colors hover:bg-black/65 focus-visible:ring-2 focus-visible:ring-white disabled:opacity-25 active:scale-95";
  return (
    <section aria-label="笔记图片">
      <div className="relative">
        <div
          ref={trackRef}
          role="region"
          aria-label="图片轮播，可左右拖动"
          aria-roledescription="轮播"
          tabIndex={images.length > 1 ? 0 : -1}
          className={cn("flex overflow-x-auto overscroll-x-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary", dragging ? "cursor-grabbing snap-none" : "cursor-grab snap-x snap-mandatory")}
          style={{ aspectRatio: ratios[images[current]?.url ?? ""] ?? 3 / 4 }}
          onScroll={event => {
            if (drag.current) return;
            const track = event.currentTarget;
            if (destination.current !== null) {
              if (Math.abs(track.scrollLeft - destination.current * track.clientWidth) > 1) return;
              destination.current = null;
            }
            const next = Math.max(0, Math.min(images.length - 1, Math.round(track.scrollLeft / track.clientWidth)));
            indexRef.current = next;
            setIndex(next);
          }}
          onKeyDown={event => {
            const next = event.key === "ArrowRight" ? current + 1 : event.key === "ArrowLeft" ? current - 1 : event.key === "Home" ? 0 : event.key === "End" ? images.length - 1 : null;
            if (next === null) return;
            event.preventDefault();
            goTo(next, true);
          }}
          onPointerDown={event => {
            destination.current = null;
            if (event.pointerType !== "mouse" || event.button !== 0 || images.length < 2) return;
            event.preventDefault();
            const track = event.currentTarget;
            // Disable snapping immediately, before the first pointer move.
            track.style.scrollSnapType = "none";
            track.setPointerCapture(event.pointerId);
            drag.current = { id: event.pointerId, x: event.clientX, left: track.scrollLeft, index: current };
            setDragging(true);
          }}
          onPointerMove={event => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            event.currentTarget.scrollLeft = start.left + start.x - event.clientX;
          }}
          onPointerUp={event => {
            const start = drag.current;
            if (!start || start.id !== event.pointerId) return;
            const distance = start.x - event.clientX;
            const next = Math.abs(distance) > Math.min(72, event.currentTarget.clientWidth * 0.18) ? start.index + Math.sign(distance) : start.index;
            drag.current = null;
            setDragging(false);
            event.currentTarget.style.scrollSnapType = "";
            event.currentTarget.releasePointerCapture(event.pointerId);
            goTo(next);
          }}
          onLostPointerCapture={() => {
            const start = drag.current;
            if (!start) return;
            drag.current = null;
            setDragging(false);
            if (trackRef.current) trackRef.current.style.scrollSnapType = "";
            goTo(start.index, true);
          }}
        >
          {images.map((image, position) => (
            <div key={`${image.url}-${position}`} className="h-full w-full shrink-0 snap-center">
              <img src={mediaUrl(image.url)} alt={`笔记图片 ${position + 1}`} aria-hidden={position !== current} draggable={false} loading={Math.abs(position - current) < 2 ? "eager" : "lazy"} className="block h-full w-full select-none object-contain" onLoad={event => {
                const imageElement = event.currentTarget;
                if (imageElement.naturalHeight) setRatios(value => ({ ...value, [image.url]: imageElement.naturalWidth / imageElement.naturalHeight }));
              }} />
            </div>
          ))}
        </div>
        {images.length > 1 ? <>
          <button type="button" aria-label="上一张图片" disabled={current === 0} onClick={() => goTo(current - 1)} className={cn(arrowClass, "left-3")}><ChevronLeft className="size-6" strokeWidth={1.75} /></button>
          <button type="button" aria-label="下一张图片" disabled={current === images.length - 1} onClick={() => goTo(current + 1)} className={cn(arrowClass, "right-3")}><ChevronRight className="size-6" strokeWidth={1.75} /></button>
        </> : null}
        <span aria-live="polite" className="pointer-events-none absolute right-3 top-3 rounded-full bg-black/45 px-3 py-1 text-xs tabular-nums text-white">{current + 1} / {images.length}</span>
        <a href={mediaUrl(images[current]?.url)} target="_blank" rel="noreferrer" className="absolute bottom-3 right-3 inline-flex items-center gap-1 rounded-full bg-black/45 px-3 py-1.5 text-[11px] text-white outline-none focus-visible:ring-2 focus-visible:ring-white"><ExternalLink className="size-3" />查看大图</a>
      </div>
      {images.length > 1 ? <div className={cn("flex gap-0.5 overflow-x-auto px-4 py-1.5", images.length > 12 ? "justify-start" : "justify-center")} aria-label="图片分页">
        {images.map((image, position) => <button key={`${image.url}-${position}`} type="button" aria-label={`查看第 ${position + 1} 张图片`} aria-pressed={position === current} onClick={() => goTo(position)} className="grid size-6 shrink-0 place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"><span className={cn("size-1.5 rounded-full", position === current ? "bg-primary" : "bg-foreground/20")} /></button>)}
      </div> : null}
    </section>
  );
}
