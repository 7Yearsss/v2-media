import { AlertCircle, Loader2, Maximize, Minimize, Pause, Play, RotateCcw, Volume2, VolumeX, ZapIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { EASE_OUT } from "@/lib/ease";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

const RATES = [0.5, 1, 1.5, 2] as const;
const HOLD_MS = 350;
const SEEK_STEP = 5;
const PREF_KEY = "v2media:video-prefs";

interface Prefs { muted: boolean; rate: number }
function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREF_KEY) ?? "null") as Partial<Prefs> | null;
    return { muted: raw?.muted ?? false, rate: RATES.includes(raw?.rate as never) ? (raw!.rate as number) : 1 };
  } catch {
    return { muted: false, rate: 1 };
  }
}
function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* Storage can be unavailable. */ }
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const fmt = (seconds: number) => formatDuration(seconds * 1000);

/**
 * 仿手机端的笔记视频播放器（原生 <video> 之上自绘控件，不加依赖）：
 * 点画面播放/暂停（中心图标弹一下）· 按住画面 2 倍速 · 底部细进度条（缓冲 + 已播，悬停/拖动变粗并显示时间）·
 * 倍速 / 静音 / 全屏 · 空格、←/→、M、F 快捷键 · 默认循环 · 滚出视野自动暂停 · 静音与倍速偏好记住。
 */
export function NoteVideoPlayer({
  src,
  poster,
  width,
  height,
  durationMs,
  className,
}: {
  src: string;
  poster?: string;
  /** 视频分辨率，用来定容器宽高比（避免加载前后跳动）。 */
  width?: number;
  height?: number;
  durationMs?: number;
  className?: string;
}) {
  const reduceMotion = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const holding = useRef(false);
  const baseRate = useRef(1);
  const scrubbingRef = useRef(false);

  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState(false);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState((durationMs ?? 0) / 1000);
  const [buffered, setBuffered] = useState(0);
  const [hover, setHover] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [hoverRatio, setHoverRatio] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const [holdFast, setHoldFast] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [flash, setFlash] = useState<{ id: number; kind: "play" | "pause" } | null>(null);

  const ratio = width && height ? clamp(width / height, 9 / 16, 4 / 3) : 3 / 4;

  // 偏好应用到元素（src 变化后元素重建，所以依赖 src）
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = prefs.muted;
    v.playbackRate = prefs.rate;
  }, [prefs, src]);

  const updatePrefs = (patch: Partial<Prefs>) =>
    setPrefs((p) => {
      const next = { ...p, ...patch };
      savePrefs(next);
      return next;
    });

  const toggle = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => setError(true));
    else v.pause();
  }, []);

  const flashIcon = (kind: "play" | "pause") => setFlash({ id: Date.now(), kind });

  const seekBy = (delta: number) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    v.currentTime = clamp(v.currentTime + delta, 0, duration);
    setCurrent(v.currentTime);
  };

  // 滚出视野自动暂停（详情面板里往下看评论时不再吵）
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => {
      if (entry && !entry.isIntersecting) videoRef.current?.pause();
    }, { threshold: 0.2 });
    io.observe(root);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);
  useEffect(() => () => { if (holdTimer.current) clearTimeout(holdTimer.current); }, []);

  // 点外面关倍速菜单
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: globalThis.PointerEvent) => {
      if (!(e.target as HTMLElement | null)?.closest("[data-rate-menu]")) setMenu(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menu]);

  const toggleFullscreen = () => {
    const root = rootRef.current;
    if (!root) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void root.requestFullscreen?.().catch(() => undefined);
  };

  // ── 画面：点按 = 播放/暂停；按住 = 2 倍速 ──
  const onSurfaceDown = (e: PointerEvent) => {
    if (e.button !== 0 || error) return;
    holding.current = false;
    holdTimer.current = setTimeout(() => {
      const v = videoRef.current;
      if (!v || v.paused) return;
      holding.current = true;
      baseRate.current = v.playbackRate;
      v.playbackRate = 2;
      setHoldFast(true);
    }, HOLD_MS);
  };
  const endHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    holdTimer.current = null;
    if (holding.current) {
      holding.current = false;
      if (videoRef.current) videoRef.current.playbackRate = baseRate.current;
      setHoldFast(false);
      return true;
    }
    return false;
  };
  const onSurfaceUp = (e: PointerEvent) => {
    if (e.button !== 0 || error) return;
    if (endHold()) return;
    const wasPaused = videoRef.current?.paused ?? true;
    toggle();
    flashIcon(wasPaused ? "play" : "pause");
  };

  // ── 进度条：点击 / 拖动定位 ──
  const ratioFromEvent = (e: PointerEvent) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return 0;
    return clamp((e.clientX - rect.left) / rect.width, 0, 1);
  };
  const seekTo = (r: number) => {
    const v = videoRef.current;
    if (!v || !duration) return;
    v.currentTime = r * duration;
    setCurrent(v.currentTime);
  };
  const onBarDown = (e: PointerEvent) => {
    if (e.button !== 0 || !duration) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    scrubbingRef.current = true;
    setScrubbing(true);
    seekTo(ratioFromEvent(e));
  };
  const onBarMove = (e: PointerEvent) => {
    const r = ratioFromEvent(e);
    setHoverRatio(r);
    if (scrubbingRef.current) seekTo(r);
  };
  const onBarUp = (e: PointerEvent) => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    setScrubbing(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onBarKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); seekBy(-SEEK_STEP); }
    if (e.key === "ArrowRight") { e.preventDefault(); e.stopPropagation(); seekBy(SEEK_STEP); }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === " ") { e.preventDefault(); toggle(); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); seekBy(-SEEK_STEP); }
    else if (e.key === "ArrowRight") { e.preventDefault(); seekBy(SEEK_STEP); }
    else if (e.key === "m" || e.key === "M") updatePrefs({ muted: !prefs.muted });
    else if (e.key === "f" || e.key === "F") toggleFullscreen();
  };

  const retry = () => {
    const v = videoRef.current;
    setError(false);
    setWaiting(true);
    if (v) { v.load(); void v.play().catch(() => undefined); }
  };

  const played = duration ? clamp(current / duration, 0, 1) : 0;
  const controlsVisible = !playing || hover || scrubbing || menu;
  const barActive = hover || scrubbing;
  const tipRatio = scrubbing ? played : hoverRatio;
  const btn = "grid size-9 place-items-center rounded-full text-white outline-none transition-colors hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white active:scale-95";

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label="视频播放器"
      tabIndex={0}
      onKeyDown={onKeyDown}
      onPointerEnter={() => setHover(true)}
      onPointerLeave={() => { setHover(false); setHoverRatio(null); endHold(); }}
      className={cn(
        "group/player relative w-full select-none overflow-hidden bg-black outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary",
        fullscreen ? "max-h-none" : "max-h-[70vh]",
        className,
      )}
      style={fullscreen ? undefined : { aspectRatio: ratio }}
    >
      {/* 画面没铺满（比例被限制在 9:16~4:3）时，两侧用放大模糊的封面填充，而不是纯黑 */}
      {poster ? <img src={poster} alt="" aria-hidden="true" draggable={false} className="pointer-events-none absolute inset-0 size-full scale-125 object-cover opacity-60 blur-2xl" /> : null}
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        loop
        playsInline
        preload="metadata"
        className="absolute inset-0 size-full object-contain"
        onPlay={() => { setPlaying(true); setStarted(true); setError(false); }}
        onPause={() => setPlaying(false)}
        onPlaying={() => setWaiting(false)}
        onWaiting={() => setWaiting(true)}
        onCanPlay={() => setWaiting(false)}
        onError={() => { setError(true); setWaiting(false); setPlaying(false); }}
        onLoadedMetadata={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }}
        onDurationChange={(e) => { if (Number.isFinite(e.currentTarget.duration)) setDuration(e.currentTarget.duration); }}
        onTimeUpdate={(e) => { if (!scrubbingRef.current) setCurrent(e.currentTarget.currentTime); }}
        onProgress={(e) => {
          const v = e.currentTarget;
          let end = 0;
          for (let i = 0; i < v.buffered.length; i++)
            if (v.buffered.start(i) <= v.currentTime + 0.5) end = Math.max(end, v.buffered.end(i));
          setBuffered(end);
        }}
      />

      {/* 点按 / 按住的触发面（盖在视频上，控件在它之上） */}
      <div
        className="absolute inset-0 cursor-pointer"
        onPointerDown={onSurfaceDown}
        onPointerUp={onSurfaceUp}
        onPointerCancel={() => void endHold()}
        aria-hidden="true"
      />

      {/* 未开始：大播放键 */}
      {!started && !error ? (
        <button
          type="button"
          aria-label="播放视频"
          onClick={() => { toggle(); flashIcon("play"); }}
          className="absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/45 text-white shadow-lg backdrop-blur-sm outline-none transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-white active:scale-95"
        >
          <Play className="ml-1 size-7 fill-current" />
        </button>
      ) : null}

      {/* 点按反馈：中心图标弹一下 */}
      <AnimatePresence>
        {flash ? (
          <motion.div
            key={flash.id}
            aria-hidden="true"
            initial={reduceMotion ? { opacity: 0.9 } : { opacity: 0.95, scale: 0.7 }}
            animate={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 1.25 }}
            transition={{ duration: 0.55, ease: EASE_OUT }}
            onAnimationComplete={() => setFlash(null)}
            className="pointer-events-none absolute left-1/2 top-1/2 grid size-16 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/55 text-white"
          >
            {flash.kind === "play" ? <Play className="ml-1 size-7 fill-current" /> : <Pause className="size-7 fill-current" />}
          </motion.div>
        ) : null}
      </AnimatePresence>

      {waiting && !error ? (
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-white/90" role="status" aria-label="缓冲中">
          <Loader2 className="size-9 animate-spin" />
        </div>
      ) : null}

      {/* 按住 2 倍速提示 */}
      <AnimatePresence>
        {holdFast ? (
          <motion.div
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className="pointer-events-none absolute left-1/2 top-3 inline-flex -translate-x-1/2 items-center gap-1 rounded-full bg-black/60 px-3 py-1 text-xs font-medium text-white backdrop-blur-sm"
          >
            <ZapIcon className="size-3.5 fill-current" />
            2× 倍速播放中
          </motion.div>
        ) : null}
      </AnimatePresence>

      {error ? (
        <div className="absolute inset-0 grid place-items-center bg-black/70 px-6 text-center text-white">
          <div className="flex flex-col items-center gap-3">
            <AlertCircle className="size-8 text-amber-400" />
            <p className="text-sm">视频加载失败</p>
            <p className="max-w-60 text-xs text-white/60">原视频链接可能已过期，或网络不稳定。</p>
            <button type="button" onClick={retry} className="inline-flex h-9 items-center gap-1.5 rounded-full bg-white/15 px-4 text-sm outline-none hover:bg-white/25 focus-visible:ring-2 focus-visible:ring-white">
              <RotateCcw className="size-4" />重试
            </button>
          </div>
        </div>
      ) : null}

      {/* 底部：渐变 + 控件 + 进度条 */}
      <div
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/25 to-transparent pt-10 transition-opacity duration-200",
          controlsVisible && !error ? "opacity-100" : "opacity-0",
        )}
      >
        <div className="pointer-events-auto flex items-center gap-1 px-2 pb-1">
          <button type="button" aria-label={playing ? "暂停" : "播放"} onClick={() => { const was = videoRef.current?.paused ?? true; toggle(); flashIcon(was ? "play" : "pause"); }} className={btn}>
            {playing ? <Pause className="size-[18px] fill-current" /> : <Play className="ml-0.5 size-[18px] fill-current" />}
          </button>
          <span className="px-1 text-xs tabular-nums text-white/90" aria-label="播放时间">
            {fmt(current)} <span className="text-white/50">/ {fmt(duration)}</span>
          </span>
          <span className="flex-1" />
          <div className="relative" data-rate-menu>
            <button type="button" aria-label="播放倍速" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((v) => !v)} className={cn(btn, "w-auto min-w-9 px-2 text-xs font-medium tabular-nums")}>
              {prefs.rate}×
            </button>
            {menu ? (
              <div role="menu" className="absolute bottom-full right-0 mb-1 w-20 rounded-2xl bg-black/80 p-1 text-white shadow-lg backdrop-blur">
                {RATES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    role="menuitemradio"
                    aria-checked={prefs.rate === r}
                    onClick={() => { updatePrefs({ rate: r }); setMenu(false); }}
                    className={cn("flex w-full items-center justify-center rounded-xl px-2 py-1.5 text-xs tabular-nums outline-none hover:bg-white/15 focus-visible:bg-white/15", prefs.rate === r && "bg-white/20 font-semibold")}
                  >
                    {r}×
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <button type="button" aria-label={prefs.muted ? "取消静音" : "静音"} onClick={() => updatePrefs({ muted: !prefs.muted })} className={btn}>
            {prefs.muted ? <VolumeX className="size-[18px]" /> : <Volume2 className="size-[18px]" />}
          </button>
          <button type="button" aria-label={fullscreen ? "退出全屏" : "全屏"} onClick={toggleFullscreen} className={btn}>
            {fullscreen ? <Minimize className="size-[18px]" /> : <Maximize className="size-[18px]" />}
          </button>
        </div>
      </div>

      {/* 进度条：始终可见的细线，悬停/拖动变粗；命中区 20px 高便于点按 */}
      <div
        ref={barRef}
        role="slider"
        tabIndex={0}
        aria-label="播放进度"
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(current)}
        aria-valuetext={`${fmt(current)} / ${fmt(duration)}`}
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={onBarUp}
        onPointerLeave={() => { if (!scrubbingRef.current) setHoverRatio(null); }}
        onKeyDown={onBarKey}
        className="group/bar absolute inset-x-0 bottom-0 z-10 flex h-5 cursor-pointer touch-none items-end outline-none"
      >
        {tipRatio !== null && barActive && duration ? (
          <span
            className="pointer-events-none absolute bottom-4 -translate-x-1/2 rounded-md bg-black/75 px-1.5 py-0.5 text-[11px] tabular-nums text-white"
            style={{ left: `${clamp(tipRatio * 100, 6, 94)}%` }}
          >
            {fmt(tipRatio * duration)}
          </span>
        ) : null}
        <div className={cn("relative w-full bg-white/25 transition-[height] duration-150", barActive ? "h-1.5" : "h-0.5")}>
          <div className="absolute inset-y-0 left-0 bg-white/35" style={{ width: `${duration ? clamp(buffered / duration, 0, 1) * 100 : 0}%` }} />
          <div className="absolute inset-y-0 left-0 bg-primary" style={{ width: `${played * 100}%` }} />
          <div
            aria-hidden="true"
            className={cn("absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow transition-opacity", barActive ? "opacity-100" : "opacity-0")}
            style={{ left: `${played * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
}
