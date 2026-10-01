import { AlertTriangle, ArrowRight, Check, Lightbulb, Loader2, PenLine, Plus, Quote } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AnalysisSignals,
  AnalysisVisualItem,
  CollectionAnalysis,
  InsightFinding,
  InsightIdea,
  InsightRef,
} from "@v2media/shared";
import { NumberTicker } from "@/components/motion/number-ticker";
import { TextReveal } from "@/components/motion/text-reveal";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/** 卡片壳：标题只有一个小标签，其余靠图。 */
function Panel({
  title,
  className,
  children,
  delay = 0,
}: {
  title: string;
  className?: string;
  children: React.ReactNode;
  delay?: number;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay, ease: "easeOut" }}
      className={cn("rounded-3xl border border-border bg-card p-5", className)}
    >
      <div className="mb-4 text-xs font-medium tracking-wide text-muted-foreground">{title}</div>
      {children}
    </motion.section>
  );
}

const refLink = (colId: number, r: InsightRef) => `/library?col=${colId}&note=${r.id}`;

/** 来源笔记小标：点了跳回内容库对应笔记。 */
function RefChips({ colId, refs }: { colId: number; refs?: InsightRef[] }) {
  if (!refs?.length) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {refs.map((r) => (
        <Link
          key={r.id}
          to={refLink(colId, r)}
          title={r.title}
          className="max-w-[10rem] truncate rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
        >
          {r.title}
        </Link>
      ))}
    </span>
  );
}

/** 爆款 vs 其余：每行两根横条，爆款一根长出来。 */
function TraitBars({ traits }: { traits: AnalysisSignals["traits"] }) {
  return (
    <div className="flex flex-col gap-4">
      {traits.map((t, i) => {
        const max = Math.max(t.hit, t.rest, 0.0001);
        return (
          <div key={t.key}>
            <div className="mb-1.5 flex items-baseline justify-between text-xs">
              <span className="text-foreground/80">{t.label}</span>
              <span className="tabular-nums text-muted-foreground">
                <b className="font-semibold text-primary">
                  {t.hit}
                  {t.unit}
                </b>
                {"  /  "}
                {t.rest}
                {t.unit}
              </span>
            </div>
            {([["hit", t.hit, "bg-primary"], ["rest", t.rest, "bg-muted-foreground/30"]] as const).map(([k, v, c], j) => (
              <div key={k} className="mb-1 h-1.5 overflow-hidden rounded-full bg-muted/60">
                <motion.div
                  className={cn("h-full rounded-full", c)}
                  initial={{ width: 0 }}
                  animate={{ width: `${(v / max) * 100}%` }}
                  transition={{ duration: 0.8, delay: 0.1 + i * 0.07 + j * 0.05, ease: "easeOut" }}
                />
              </div>
            ))}
          </div>
        );
      })}
      <div className="flex items-center gap-4 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-primary" />爆款</span>
        <span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-muted-foreground/30" />其余</span>
      </div>
    </div>
  );
}

/** 标题钩子增益：×N 倍，样本不足的灰掉。 */
function HookLift({ hooks }: { hooks: AnalysisSignals["hooks"] }) {
  const max = Math.max(...hooks.map((h) => h.lift ?? 0), 1);
  return (
    <div className="flex flex-col gap-3.5">
      {hooks.map((h, i) => (
        <div key={h.key} title={`例：${h.example}`}>
          <div className="mb-1 flex items-baseline justify-between text-xs">
            <span>{h.label}</span>
            <span className="tabular-nums text-muted-foreground">
              {h.lift != null ? <b className={cn("font-semibold", h.lift >= 1.5 ? "text-emerald-500" : h.lift < 1 ? "text-rose-500" : "text-foreground")}>×{h.lift}</b> : "样本不足"}
              <span className="ml-2 opacity-70">{h.count}篇</span>
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted/60">
            <motion.div
              className={cn("h-full rounded-full", h.lift == null ? "bg-muted-foreground/25" : h.lift < 1 ? "bg-rose-500/70" : "bg-emerald-500")}
              initial={{ width: 0 }}
              animate={{ width: `${((h.lift ?? 0.3) / max) * 100}%` }}
              transition={{ duration: 0.8, delay: 0.1 + i * 0.07, ease: "easeOut" }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

const KIND_META = {
  tool: { label: "收藏型", color: "bg-sky-500" },
  talk: { label: "讨论型", color: "bg-amber-500" },
  like: { label: "点赞型", color: "bg-rose-400" },
} as const;

/** 笔记类型散点：横轴评赞比（讨论度），纵轴藏赞比（收藏理由），点大小=互动量。 */
function TypeScatter({ points, colId }: { points: AnalysisSignals["points"]; colId: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // 用 90 分位定轴，避免一个离群点把其余挤成一团；超出的点贴边
  const q = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] ?? 0;
  const xMax = Math.max(0.15, q(points.map((p) => p.talkRate))) * 1.15;
  const yMax = Math.max(0.4, q(points.map((p) => p.saveRate))) * 1.15;
  const clamp = (v: number) => Math.min(1, v);
  const eMax = Math.max(...points.map((p) => p.engagement), 1);
  const cur = points.find((p) => p.ref === hover);
  return (
    <div>
      <div className="relative h-56 rounded-2xl bg-muted/40">
        <span className="absolute bottom-1.5 right-3 text-[10px] text-muted-foreground">评论多 →</span>
        <span className="absolute left-3 top-1.5 text-[10px] text-muted-foreground">↑ 收藏多</span>
        {points.map((p, i) => {
          const size = 8 + Math.sqrt(p.engagement / eMax) * 18;
          const id = p.id || undefined;
          const dot = (
            <motion.span
              onMouseEnter={() => setHover(p.ref)}
              onMouseLeave={() => setHover(null)}
              className={cn("absolute block cursor-pointer rounded-full opacity-80 ring-2 ring-card transition-opacity hover:opacity-100", KIND_META[p.kind].color)}
              style={{ left: `${clamp(p.talkRate / xMax) * 92 + 2}%`, bottom: `${clamp(p.saveRate / yMax) * 86 + 6}%`, width: size, height: size, marginLeft: -size / 2, marginBottom: -size / 2 }}
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 0.8 }}
              transition={{ type: "spring", stiffness: 260, damping: 18, delay: 0.15 + Math.min(i, 30) * 0.025 }}
            />
          );
          return id ? <Link key={p.ref} to={`/library?col=${colId}&note=${id}`}>{dot}</Link> : <span key={p.ref}>{dot}</span>;
        })}
      </div>
      <div className="mt-3 flex min-h-5 items-center justify-between gap-3 text-xs">
        <div className="flex gap-3 text-muted-foreground">
          {Object.values(KIND_META).map((k) => (
            <span key={k.label} className="flex items-center gap-1.5"><i className={cn("size-2 rounded-full", k.color)} />{k.label}</span>
          ))}
        </div>
        <span className="min-w-0 truncate text-foreground/80">{cur ? `${cur.title} · ${formatCount(cur.engagement)}` : ""}</span>
      </div>
    </div>
  );
}

const CMT_COLORS = ["#0ea5e9", "#f59e0b", "#10b981", "#f43f5e", "#a1a1aa"];

/** 评论构成圆环：扇区依次画出，悬停某类显示一条代表评论。 */
function CommentRing({ data }: { data: NonNullable<AnalysisSignals["comments"]> }) {
  const [hover, setHover] = useState(0);
  const R = 44;
  const C = 2 * Math.PI * R;
  let acc = 0;
  const cats = data.categories;
  const cur = cats[hover];
  return (
    <div className="flex items-center gap-5">
      <div className="relative size-36 shrink-0">
        <svg viewBox="0 0 120 120" className="size-full -rotate-90">
          <circle cx="60" cy="60" r={R} fill="none" strokeWidth="14" className="stroke-muted/60" />
          {cats.map((c, i) => {
            const len = (c.count / data.total) * C;
            const off = acc;
            acc += len;
            return (
              <motion.circle
                key={c.key}
                cx="60"
                cy="60"
                r={R}
                fill="none"
                strokeWidth={hover === i ? 17 : 14}
                stroke={CMT_COLORS[i % CMT_COLORS.length]}
                strokeDasharray={`${Math.max(0, len - 2)} ${C}`}
                strokeDashoffset={-off}
                initial={{ opacity: 0, pathLength: 0 }}
                animate={{ opacity: 1, pathLength: 1 }}
                transition={{ duration: 0.6, delay: 0.15 + i * 0.12 }}
                onMouseEnter={() => setHover(i)}
                className="cursor-pointer transition-[stroke-width]"
              />
            );
          })}
        </svg>
        <div className="absolute inset-0 grid place-items-center text-center">
          <div>
            <NumberTicker value={data.total} className="text-xl font-semibold tabular-nums" />
            <div className="text-[10px] text-muted-foreground">条评论</div>
          </div>
        </div>
      </div>
      <div className="min-w-0 flex-1">
        <ul className="flex flex-col gap-1.5">
          {cats.map((c, i) => (
            <li
              key={c.key}
              onMouseEnter={() => setHover(i)}
              className={cn("flex cursor-default items-center gap-2 text-xs transition-opacity", hover === i ? "opacity-100" : "opacity-60")}
            >
              <i className="size-2 shrink-0 rounded-full" style={{ background: CMT_COLORS[i % CMT_COLORS.length] }} />
              <span className="flex-1">{c.label}</span>
              <span className="tabular-nums text-muted-foreground">{Math.round((c.count / data.total) * 100)}%</span>
            </li>
          ))}
        </ul>
        {cur?.sample && (
          <div className="mt-3 line-clamp-2 rounded-xl bg-muted/50 px-3 py-2 text-xs text-muted-foreground">“{cur.sample}”</div>
        )}
      </div>
    </div>
  );
}

/** 爆款发布时间：周一到周日 7 根柱。 */
function WeekdayBars({ timing }: { timing: NonNullable<AnalysisSignals["timing"]> }) {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  const max = Math.max(...timing.byWeekday, 1);
  const best = timing.byWeekday.indexOf(max);
  return (
    <div className="flex h-24 items-end gap-2">
      {timing.byWeekday.map((n, d) => (
        <div key={d} className="flex flex-1 flex-col items-center gap-1.5">
          <motion.div
            className={cn("w-full rounded-t-lg", d === best ? "bg-primary" : "bg-muted-foreground/25")}
            initial={{ height: 0 }}
            animate={{ height: `${Math.max(4, (n / max) * 100)}%` }}
            transition={{ duration: 0.7, delay: 0.1 + d * 0.05, ease: "easeOut" }}
            title={`周${names[d]}：${n} 篇爆款`}
          />
          <span className="text-[10px] text-muted-foreground">{names[d]}</span>
        </div>
      ))}
    </div>
  );
}

/** AI 看过的封面：爆款在前、对照组在后，悬停看它抓人的点。 */
function CoverStrip({ items, colId }: { items: AnalysisVisualItem[]; colId: number }) {
  const hits = items.filter((i) => i.hit);
  const kinds = new Map<string, number>();
  for (const i of hits) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5">
        {[...kinds.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([k, n]) => (
            <span key={k} className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
              {k} ×{n}
            </span>
          ))}
      </div>
      <div className="-mx-1 flex gap-3 overflow-x-auto overflow-y-hidden px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {items.map((it, i) => (
          <motion.div
            key={it.id}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.1 + i * 0.06 }}
            className="w-32 shrink-0"
          >
            <Link to={`/library?col=${colId}&note=${it.id}`} title={it.hook} className="group relative block aspect-[3/4] overflow-hidden rounded-2xl bg-muted">
              <img src={it.cover} alt="" className="size-full object-cover transition-transform duration-300 group-hover:scale-105" />
              <span className={cn("absolute left-2 top-2 rounded-full px-2 py-0.5 text-[10px] font-medium backdrop-blur", it.hit ? "bg-primary/90 text-primary-foreground" : "bg-black/50 text-white")}>
                {it.hit ? "爆款" : "对照"}
              </span>
              <span className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-6 text-[11px] leading-4 text-white">
                {it.kind}
                <span className="ml-1 opacity-80">{formatCount(it.engagement)}</span>
              </span>
            </Link>
            {it.text && <div className="mt-1.5 line-clamp-2 text-[11px] leading-4 text-muted-foreground">“{it.text}”</div>}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

const SEG_COLORS = ["bg-sky-500", "bg-primary", "bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];

/** 视频拆解：一条时间轴，每段按时长占比，悬停看这一段在做什么；下面一行口播、一行结尾。 */
function VideoTimeline({ items, colId }: { items: AnalysisVisualItem[]; colId: number }) {
  const [hover, setHover] = useState<Record<number, number>>({});
  return (
    <div className="flex flex-col gap-5">
      {items.map((it, k) => {
        const v = it.video!;
        const total = Math.max(...v.segments.map((x) => x.to), v.durationSec ?? 0, 1);
        const cur = v.segments[hover[it.id] ?? 0];
        return (
          <div key={it.id} className="flex gap-4">
            <Link to={`/library?col=${colId}&note=${it.id}`} className="aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-xl bg-muted">
              <img src={it.cover} alt="" className="size-full object-cover" />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm font-semibold">{it.title}</div>
              <div className="mt-2 flex h-7 gap-0.5 overflow-hidden rounded-lg">
                {v.segments.map((s, i) => (
                  <motion.button
                    key={i}
                    type="button"
                    onMouseEnter={() => setHover((h) => ({ ...h, [it.id]: i }))}
                    className={cn("grid min-w-0 place-items-center text-[10px] font-medium text-white", SEG_COLORS[i % SEG_COLORS.length], (hover[it.id] ?? 0) === i ? "opacity-100" : "opacity-60")}
                    style={{ flexBasis: `${((s.to - s.from) / total) * 100}%` }}
                    initial={{ scaleX: 0, originX: 0 }}
                    animate={{ scaleX: 1 }}
                    transition={{ duration: 0.5, delay: 0.1 + i * 0.07 }}
                  >
                    {s.from}s
                  </motion.button>
                ))}
              </div>
              <div className="mt-1.5 min-h-4 text-xs text-foreground/80">{cur ? `${cur.from}-${cur.to}s　${cur.what}` : ""}</div>
              <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                <span className="rounded-full bg-primary/10 px-2.5 py-1 text-primary">开头：{v.opening.line || v.opening.visual}</span>
                <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">{v.voiceover}</span>
                <span className="rounded-full bg-muted px-2.5 py-1 text-muted-foreground">结尾：{v.ending}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const CONF = { high: 3, mid: 2, low: 1 } as const;

/** 一条论证：判断（粗）→ 证据（标签）→ 边界 / 怎么做（各一行带图标）。 */
function FindingCard({ f, i, colId }: { f: InsightFinding; i: number; colId: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: 0.1 + i * 0.1 }}
      className="flex flex-col gap-3 rounded-2xl bg-muted/40 p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="text-[15px] font-semibold leading-6">{f.claim}</div>
        <span className="mt-1.5 flex shrink-0 gap-0.5" title={`把握度：${f.confidence}`}>
          {[1, 2, 3].map((n) => (
            <i key={n} className={cn("size-1.5 rounded-full", n <= CONF[f.confidence] ? "bg-primary" : "bg-muted-foreground/25")} />
          ))}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {f.evidence.map((e, k) => (
          <span key={k} className="rounded-full bg-card px-2.5 py-1 text-xs text-foreground/80 ring-1 ring-border">{e}</span>
        ))}
      </div>
      <div className="flex flex-col gap-1.5 text-xs">
        {f.boundary && (
          <div className="flex items-start gap-1.5 text-amber-600 dark:text-amber-400">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{f.boundary}
          </div>
        )}
        {f.todo && (
          <div className="flex items-start gap-1.5 font-medium text-primary">
            <ArrowRight className="mt-0.5 size-3.5 shrink-0" />{f.todo}
          </div>
        )}
      </div>
      <RefChips colId={colId} refs={f.refs} />
    </motion.div>
  );
}

/** 选题卡：一键入选题池（带来源笔记）。 */
function IdeaCard({ idea, i, colId, added, onAdd, onWrite, writing, pending }: { idea: InsightIdea; i: number; colId: number; added: boolean; onAdd: () => void; onWrite: () => void; writing: boolean; pending: boolean }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, delay: 0.1 + i * 0.08 }}
      className="flex flex-col gap-2 rounded-2xl border border-border p-4"
    >
      <div className="text-[15px] font-semibold leading-6">{idea.title}</div>
      <div className="text-sm leading-6 text-foreground/80">“{idea.hook}”</div>
      <div className="text-xs text-muted-foreground">{idea.angle}</div>
      <div className="mt-1 flex items-center justify-between gap-2">
        <RefChips colId={colId} refs={idea.refs} />
        <button
          onClick={onAdd}
          disabled={added || pending}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors",
            added ? "bg-emerald-500/15 text-emerald-600" : "bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground",
          )}
        >
          {added ? <Check className="size-3.5" /> : <Plus className="size-3.5" />}
          {added ? "已入池" : "入选题池"}
        </button>
        <button
          onClick={onWrite}
          disabled={writing}
          className="flex shrink-0 items-center gap-1 rounded-full bg-primary px-3 py-1 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-50"
        >
          {writing ? <Loader2 className="size-3.5 animate-spin" /> : <PenLine className="size-3.5" />}
          {writing ? "写稿中…" : "写成草稿"}
        </button>
      </div>
    </motion.div>
  );
}

export function AnalysisReport({ a, onTopicAdded }: { a: CollectionAnalysis; onTopicAdded?: () => void }) {
  const running = a.status === "running";
  const toast = useToast();
  const { stats, insight } = a.data;
  const sig = stats.signals!;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [added, setAdded] = useState<Set<number>>(new Set());
  const topicIds = useRef(new Map<number, number>());
  const [writingIdx, setWritingIdx] = useState<number | null>(null);
  const addTopic = useMutation({
    mutationFn: async (i: number) => {
      const idea = insight!.ideas![i]!;
      const t = await api.createTopic({
        title: idea.title,
        angle: `${idea.hook}\n${idea.angle}`,
        collectionId: a.collectionId,
        sourceNoteId: idea.refs?.[0]?.id,
      });
      topicIds.current.set(i, t.id);
      return i;
    },
    onSuccess: (i) => {
      setAdded((s) => new Set(s).add(i));
      onTopicAdded?.();
    },
    onError: (e) => toast.error("入池失败", e instanceof Error ? e.message : undefined),
  });
  // 选题 → AI 成稿 → 跳到草稿页（还没入池的先入池，保留来源关联）
  const writeDraft = async (i: number) => {
    setWritingIdx(i);
    try {
      if (!topicIds.current.has(i)) await addTopic.mutateAsync(i);
      const r = await api.topicToDraft(topicIds.current.get(i)!, { ai: true, positioning: a.data.positioning });
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      const note = [r.coverText ? `封面大字：${r.coverText}` : "", r.warnings?.length ? `仍有 ${r.warnings.length} 处可能被限流的词` : ""].filter(Boolean).join("；");
      toast.success("草稿已生成", note || undefined);
      navigate(`/drafts/${r.draft.id}`);
    } catch (e) {
      toast.error("成稿失败", e instanceof Error ? e.message : undefined);
    } finally {
      setWritingIdx(null);
    }
  };
  const addAll = async () => {
    for (const [i] of (insight?.ideas ?? []).entries()) if (!added.has(i)) await addTopic.mutateAsync(i).catch(() => {});
    toast.success("已全部入选题池");
  };
  const lowCoverage = sig.sample.withDetail < sig.sample.total * 0.6;

  return (
    <div className="flex flex-col gap-4">
      {/* 一句话判断 + 样本芯片 */}
      <div className="rounded-3xl border border-primary/25 bg-gradient-to-br from-primary/10 to-transparent p-6">
        {insight?.summary ? (
          <TextReveal text={insight.summary} className="text-xl font-semibold leading-8" split="word" stagger={0.03} once />
        ) : running ? (
          <TextShimmer className="text-xl font-semibold leading-8 text-muted-foreground">AI 正在解读这些信号…</TextShimmer>
        ) : (
          <div className="text-sm text-muted-foreground">AI 没有产出结构化结论，下面是代码算出的信号</div>
        )}
        <div className="mt-4 flex flex-wrap gap-2 text-xs">
          {[
            [sig.sample.total, "篇样本"],
            [sig.sample.hit, "篇爆款"],
            [sig.sample.withComments, "篇有评论"],
            [sig.sample.videos, "个视频"],
          ].map(([n, l]) => (
            <span key={l} className="rounded-full bg-card/80 px-3 py-1 ring-1 ring-border">
              <NumberTicker value={Number(n)} className="font-semibold tabular-nums" /> {l}
            </span>
          ))}
          {a.data.positioning && <span className="rounded-full bg-primary/15 px-3 py-1 text-primary">{a.data.positioning}</span>}
          {lowCoverage && <span className="rounded-full bg-amber-500/15 px-3 py-1 text-amber-600">多数笔记没进详情页，结论偏保守</span>}
        </div>
      </div>

      {/* AI 看过的封面 */}
      {a.data.visual?.length ? (
        <Panel title="AI 看过的封面" delay={0.05}>
          <CoverStrip items={a.data.visual} colId={a.collectionId} />
        </Panel>
      ) : null}

      {/* 视频拆解 */}
      {a.data.visual?.some((i) => i.video) ? (
        <Panel title="爆款视频拆解" delay={0.08}>
          <VideoTimeline items={a.data.visual.filter((i) => i.video)} colId={a.collectionId} />
        </Panel>
      ) : null}

      {/* 论证过的结论 */}
      {insight?.findings?.length ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {insight.findings.map((f, i) => (
            <FindingCard key={i} f={f} i={i} colId={a.collectionId} />
          ))}
        </div>
      ) : null}

      {/* 信号图：差异 / 钩子 */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="爆款 vs 其余" delay={0.1}><TraitBars traits={sig.traits} /></Panel>
        {sig.hooks.length > 0 && <Panel title="标题钩子 · 带它的中位互动是不带的几倍" delay={0.15}><HookLift hooks={sig.hooks} /></Panel>}
      </div>

      {/* 散点 / 评论环 */}
      <div className="grid gap-4 lg:grid-cols-2">
        {sig.points.length >= 3 && (
          <Panel title="笔记类型" delay={0.2}><TypeScatter points={sig.points} colId={a.collectionId} /></Panel>
        )}
        {sig.comments ? (
          <Panel title="评论在说什么" delay={0.25}><CommentRing data={sig.comments} /></Panel>
        ) : sig.timing ? (
          <Panel title="爆款发布星期" delay={0.25}><WeekdayBars timing={sig.timing} /></Panel>
        ) : null}
      </div>

      {sig.comments && sig.timing && (
        <Panel title="爆款发布星期" delay={0.3}><WeekdayBars timing={sig.timing} /></Panel>
      )}

      {/* 没被满足的需求 */}
      {insight?.needs?.length ? (
        <Panel title="观众想要但没人给" delay={0.3}>
          <div className="grid gap-3 md:grid-cols-2">
            {insight.needs.map((n, i) => (
              <motion.div
                key={i}
                initial={{ opacity: 0, x: -8 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: 0.2 + i * 0.1 }}
                className="rounded-2xl bg-muted/40 p-4"
              >
                <div className="flex items-start gap-2 text-sm text-foreground/80">
                  <Quote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />“{n.quote}”
                </div>
                <div className="mt-2 flex items-center justify-between gap-2">
                  <span className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">{n.need}</span>
                  <RefChips colId={a.collectionId} refs={n.refs} />
                </div>
              </motion.div>
            ))}
          </div>
        </Panel>
      ) : null}

      {/* 选题：可直接入池 */}
      {insight?.ideas?.length ? (
        <Panel title="可以直接做的选题" delay={0.35}>
          <div className="mb-3 flex justify-end">
            <button
              onClick={() => void addAll()}
              disabled={addTopic.isPending || added.size === insight.ideas.length}
              className="flex items-center gap-1.5 rounded-full bg-primary px-3.5 py-1.5 text-xs font-medium text-primary-foreground transition-opacity disabled:opacity-40"
            >
              <Lightbulb className="size-3.5" />全部入选题池
            </button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {insight.ideas.map((idea, i) => (
              <IdeaCard
                key={i}
                idea={idea}
                i={i}
                colId={a.collectionId}
                added={added.has(i)}
                pending={addTopic.isPending}
                onAdd={() => addTopic.mutate(i)}
                onWrite={() => void writeDraft(i)}
                writing={writingIdx === i}
              />
            ))}
          </div>
        </Panel>
      ) : null}

      {/* 不可复制 */}
      {(insight?.traps?.length || sig.traps.length) ? (
        <Panel title="看着火，但别照抄" delay={0.4}>
          <div className="flex flex-col gap-2">
            {(insight?.traps?.length ? insight.traps : sig.traps.map((t) => ({ title: t.title, reason: t.detail }))).map((t, i) => (
              <div key={i} className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
                <span className="truncate font-medium">{t.title}</span>
                <span className="ml-auto shrink-0 text-muted-foreground">{t.reason}</span>
              </div>
            ))}
          </div>
        </Panel>
      ) : null}

      {!insight && a.report ? (
        <div className="whitespace-pre-wrap rounded-2xl border border-border bg-card p-6 text-sm leading-7">{a.report}</div>
      ) : null}
    </div>
  );
}
