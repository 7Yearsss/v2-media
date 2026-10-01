import { Loader2, PenLine, Plus } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AnalysisSignals, AnalysisVisualItem, CollectionAnalysis, InsightFinding, InsightRef } from "@v2media/shared";
import { TextShimmer } from "@/components/motion/text-shimmer";
import { AnalysisProgressView } from "@/components/app/analysis-progress";
import { api } from "@/lib/api";
import { formatCount } from "@/lib/format";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

/* ───────── 版式零件 ───────── */

/** 区块：标题是一句完整的话（不是小灰字标签），区块之间只靠留白和一根细线分隔。 */
function Section({ title, aside, children }: { title: string; aside?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-t border-border/60 pt-10">
      <div className="mb-6 flex items-baseline justify-between gap-4">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** 来源笔记：行内的小链接，点了回到内容库对应笔记。 */
function Sources({ colId, refs }: { colId: number; refs?: InsightRef[] }) {
  if (!refs?.length) return null;
  return (
    <span className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
      {refs.map((r) => (
        <Link key={r.id} to={`/library?col=${colId}&note=${r.id}`} title={r.title} className="max-w-[14rem] truncate underline decoration-border underline-offset-4 transition-colors hover:text-primary hover:decoration-primary">
          {r.title}
        </Link>
      ))}
    </span>
  );
}

/* ───────── 封面墙：整页唯一的“重”元素 ───────── */

function CoverWall({ items, colId }: { items: AnalysisVisualItem[]; colId: number }) {
  const reduce = useReducedMotion();
  const hits = items.filter((i) => i.hit);
  const lows = items.filter((i) => !i.hit);
  const kinds = new Map<string, number>();
  for (const i of hits) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1);
  const top = [...kinds.entries()].sort((a, b) => b[1] - a[1])[0];
  const tile = (it: AnalysisVisualItem, i: number) => (
    <motion.div
      key={it.id}
      initial={reduce ? false : { opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, delay: i * 0.05, ease: "easeOut" }}
      className="w-36 shrink-0"
    >
      <Link to={`/library?col=${colId}&note=${it.id}`} title={it.hook || it.title} className="group block aspect-[3/4] overflow-hidden rounded-lg bg-muted">
        <img src={it.cover} alt="" className="size-full object-cover transition-transform duration-500 group-hover:scale-[1.04]" />
      </Link>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <span className={cn("text-sm font-semibold tabular-nums", !it.hit && "text-muted-foreground")}>{formatCount(it.engagement)}</span>
        <span className="truncate text-xs text-muted-foreground">{it.kind}</span>
      </div>
      {it.text && <p className="mt-1 line-clamp-2 text-xs leading-4 text-muted-foreground">{it.text}</p>}
    </motion.div>
  );
  return (
    <div>
      {top && <p className="mb-5 text-sm text-muted-foreground">爆款封面以「{top[0]}」为主，{hits.length} 篇里占 {top[1]} 篇。</p>}
      <div className="-mx-1 flex gap-4 overflow-x-auto overflow-y-hidden px-1 pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {hits.map((it, i) => tile(it, i))}
        {lows.length > 0 && (
          <>
            <div className="mx-1 flex shrink-0 items-center gap-3 self-stretch">
              <div className="w-px self-stretch bg-border" />
              <span className="text-xs text-muted-foreground [writing-mode:vertical-rl]">同类但没火</span>
            </div>
            {lows.map((it, i) => tile(it, hits.length + i))}
          </>
        )}
      </div>
    </div>
  );
}

/* ───────── 做法：一行一条，左边是判断和证据，右边是下一篇怎么写 ───────── */

function FindingRow({ f, colId }: { f: InsightFinding; colId: number }) {
  const strength = { high: 3, mid: 2, low: 1 }[f.confidence];
  return (
    <li className="grid gap-x-12 gap-y-4 py-7 first:pt-0 md:grid-cols-2">
      <div>
        <div className="flex items-start justify-between gap-4">
          <h3 className="text-[19px] font-semibold leading-snug tracking-tight">{f.claim}</h3>
          <span className="mt-2 flex shrink-0 gap-0.5" title={{ high: "把握大", mid: "把握中等", low: "把握小，样本少" }[f.confidence]}>
            {[1, 2, 3].map((n) => (
              <i key={n} className={cn("h-3 w-1 rounded-full", n <= strength ? "bg-foreground/70" : "bg-border")} />
            ))}
          </span>
        </div>
        <ul className="mt-3 space-y-1 text-sm leading-6 text-muted-foreground">
          {f.evidence.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
        <Sources colId={colId} refs={f.refs} />
      </div>
      <div className="border-l-2 border-primary/60 pl-5">
        <p className="text-[15px] leading-7">
          <span className="text-muted-foreground">下一篇　</span>
          {f.todo}
        </p>
        {f.boundary && (
          <p className="mt-2 text-sm leading-6 text-muted-foreground">
            <span>不灵的时候　</span>
            {f.boundary}
          </p>
        )}
      </div>
    </li>
  );
}

/* ───────── 差异：哑铃图 + 以“持平”为中线的发散条 ───────── */

function Dumbbells({ traits }: { traits: AnalysisSignals["traits"] }) {
  const reduce = useReducedMotion();
  return (
    <div>
      {traits.map((t, i) => {
        const max = Math.max(t.hit, t.rest, 0.0001);
        const at = (v: number) => (v / max) * 88 + 4;
        const lo = Math.min(at(t.hit), at(t.rest));
        const hi = Math.max(at(t.hit), at(t.rest));
        return (
          <div key={t.key} className="grid grid-cols-[5rem_1fr] items-center gap-4 py-2.5">
            <span className="text-sm">{t.label}</span>
            <div className="relative h-11">
              <div className="absolute inset-x-0 top-1/2 h-px bg-border" />
              <motion.div
                className="absolute top-1/2 h-[3px] -translate-y-1/2 rounded-full bg-foreground/15"
                style={{ left: `${lo}%`, width: `${hi - lo}%`, originX: 0 }}
                initial={reduce ? false : { scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.7, delay: 0.1 + i * 0.06, ease: "easeOut" }}
              />
              <i className="absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-card ring-2 ring-muted-foreground/50" style={{ left: `${at(t.rest)}%` }} />
              <i className="absolute top-1/2 size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-4 ring-primary/15" style={{ left: `${at(t.hit)}%` }} />
              <span className="absolute top-0 -translate-x-1/2 text-xs font-semibold tabular-nums text-primary" style={{ left: `${at(t.hit)}%` }}>
                {t.hit}
                {t.unit}
              </span>
              <span className="absolute bottom-0 -translate-x-1/2 text-xs tabular-nums text-muted-foreground" style={{ left: `${at(t.rest)}%` }}>
                {t.rest}
                {t.unit}
              </span>
            </div>
          </div>
        );
      })}
      <p className="mt-3 flex items-center gap-4 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <i className="size-2.5 rounded-full bg-primary" />
          爆款
        </span>
        <span className="flex items-center gap-1.5">
          <i className="size-2.5 rounded-full bg-card ring-2 ring-muted-foreground/50" />
          其余
        </span>
      </p>
    </div>
  );
}

function HookSpread({ hooks }: { hooks: AnalysisSignals["hooks"] }) {
  const maxDelta = Math.max(...hooks.map((h) => (h.lift == null ? 0 : Math.abs(h.lift - 1))), 0.5);
  return (
    <div>
      {hooks.map((h) => {
        const delta = h.lift == null ? 0 : (h.lift - 1) / maxDelta; // -1..1
        const w = Math.abs(delta) * 46;
        return (
          <div key={h.key} className="grid grid-cols-[8rem_1fr_3.5rem] items-center gap-3 py-2.5" title={`例：${h.example}`}>
            <span className="text-sm">
              {h.label}
              <span className="ml-1.5 whitespace-nowrap text-xs text-muted-foreground">{h.count} 篇</span>
            </span>
            <div className="relative h-4">
              <div className="absolute inset-y-0 left-1/2 w-px bg-foreground/30" />
              {h.lift != null && (
                <div
                  className={cn("absolute top-1/2 h-2.5 -translate-y-1/2", delta >= 0 ? "left-1/2 rounded-r-full bg-emerald-500" : "right-1/2 rounded-l-full bg-rose-500/80")}
                  style={{ width: `${w}%` }}
                />
              )}
            </div>
            <span className={cn("text-right text-sm font-semibold tabular-nums", h.lift == null ? "text-xs font-normal text-muted-foreground" : h.lift >= 1 ? "text-emerald-600 dark:text-emerald-400" : "text-rose-500")}>
              {h.lift == null ? "样本少" : `×${h.lift}`}
            </span>
          </div>
        );
      })}
      <p className="mt-3 text-xs text-muted-foreground">中线是持平：带这个钩子的笔记，中位互动比不带的高（右）或低（左）几倍。</p>
    </div>
  );
}

/* ───────── 笔记的性格：散点 / 评论构成 / 发布星期 ───────── */

const KIND = {
  tool: { label: "收藏型", dot: "bg-sky-500" },
  talk: { label: "讨论型", dot: "bg-amber-500" },
  like: { label: "点赞型", dot: "bg-rose-400" },
} as const;

function Personality({ points, colId }: { points: AnalysisSignals["points"]; colId: number }) {
  const reduce = useReducedMotion();
  const [hover, setHover] = useState<number | null>(null);
  const q = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.9)] ?? 0;
  const xMax = Math.max(0.15, q(points.map((p) => p.talkRate))) * 1.15;
  const yMax = Math.max(0.4, q(points.map((p) => p.saveRate))) * 1.15;
  const eMax = Math.max(...points.map((p) => p.engagement), 1);
  const clamp = (v: number) => Math.min(1, v);
  const cur = points.find((p) => p.ref === hover);
  return (
    <div>
      <div className="relative h-60 border-b border-l border-border">
        <span className="absolute left-3 top-2 text-xs text-muted-foreground">收藏多</span>
        <span className="absolute bottom-2 right-3 text-xs text-muted-foreground">评论多</span>
        {points.map((p, i) => {
          const size = 8 + Math.sqrt(p.engagement / eMax) * 18;
          const dot = (
            <motion.span
              onMouseEnter={() => setHover(p.ref)}
              onMouseLeave={() => setHover(null)}
              className={cn("absolute block cursor-pointer rounded-full opacity-80 ring-2 ring-background transition-opacity hover:opacity-100", KIND[p.kind].dot)}
              style={{ left: `${clamp(p.talkRate / xMax) * 92 + 3}%`, bottom: `${clamp(p.saveRate / yMax) * 86 + 6}%`, width: size, height: size, marginLeft: -size / 2, marginBottom: -size / 2 }}
              initial={reduce ? false : { scale: 0 }}
              animate={{ scale: 1 }}
              transition={{ type: "spring", stiffness: 260, damping: 20, delay: 0.1 + Math.min(i, 30) * 0.02 }}
            />
          );
          return p.id ? (
            <Link key={p.ref} to={`/library?col=${colId}&note=${p.id}`}>
              {dot}
            </Link>
          ) : (
            <span key={p.ref}>{dot}</span>
          );
        })}
      </div>
      <div className="mt-3 flex min-h-5 items-center justify-between gap-4 text-xs text-muted-foreground">
        <span className="flex gap-4">
          {Object.values(KIND).map((k) => (
            <span key={k.label} className="flex items-center gap-1.5">
              <i className={cn("size-2 rounded-full", k.dot)} />
              {k.label}
            </span>
          ))}
        </span>
        <span className="min-w-0 truncate text-foreground">{cur ? `${cur.title}　${formatCount(cur.engagement)}` : ""}</span>
      </div>
    </div>
  );
}

const CMT = ["bg-sky-500", "bg-amber-500", "bg-emerald-500", "bg-rose-400", "bg-muted-foreground/40"];

function CommentSplit({ data }: { data: NonNullable<AnalysisSignals["comments"]> }) {
  const reduce = useReducedMotion();
  return (
    <div>
      <div className="flex h-3 overflow-hidden rounded-full bg-muted">
        {data.categories.map((c, i) => (
          <motion.div
            key={c.key}
            className={cn("h-full border-r-2 border-background last:border-r-0", CMT[i % CMT.length])}
            style={{ width: `${(c.count / data.total) * 100}%`, originX: 0 }}
            initial={reduce ? false : { scaleX: 0 }}
            animate={{ scaleX: 1 }}
            transition={{ duration: 0.6, delay: 0.1 + i * 0.08, ease: "easeOut" }}
          />
        ))}
      </div>
      <ul className="mt-4 space-y-2.5">
        {data.categories.map((c, i) => (
          <li key={c.key} className="grid grid-cols-[0.75rem_1fr_2.5rem] items-baseline gap-x-3 text-sm">
            <i className={cn("size-2 translate-y-px rounded-full", CMT[i % CMT.length])} />
            <span>
              {c.label}
              {c.sample && <span className="ml-2 text-xs text-muted-foreground">“{c.sample}”</span>}
            </span>
            <span className="text-right tabular-nums text-muted-foreground">{Math.round((c.count / data.total) * 100)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function WeekdayRow({ timing }: { timing: NonNullable<AnalysisSignals["timing"]> }) {
  const names = ["日", "一", "二", "三", "四", "五", "六"];
  const max = Math.max(...timing.byWeekday, 1);
  const best = timing.byWeekday.indexOf(max);
  return (
    <div className="flex h-20 items-end gap-2">
      {timing.byWeekday.map((n, d) => (
        <div key={d} className="flex flex-1 flex-col items-center gap-1.5" title={`周${names[d]}：${n} 篇爆款`}>
          <div className={cn("w-full rounded-t-sm", d === best ? "bg-primary" : "bg-foreground/15")} style={{ height: `${Math.max(6, (n / max) * 100)}%` }} />
          <span className={cn("text-xs", d === best ? "font-semibold text-foreground" : "text-muted-foreground")}>{names[d]}</span>
        </div>
      ))}
    </div>
  );
}

/* ───────── 视频拆解（默认不跑，开了才有） ───────── */

const SEG = ["bg-sky-500", "bg-primary", "bg-emerald-500", "bg-amber-500", "bg-violet-500", "bg-rose-400", "bg-teal-500", "bg-orange-400"];

function VideoTimeline({ items, colId }: { items: AnalysisVisualItem[]; colId: number }) {
  const [hover, setHover] = useState<Record<number, number>>({});
  return (
    <div className="space-y-8">
      {items.map((it) => {
        const v = it.video!;
        const total = Math.max(...v.segments.map((x) => x.to), v.durationSec ?? 0, 1);
        const cur = v.segments[hover[it.id] ?? 0];
        return (
          <div key={it.id} className="flex gap-5">
            <Link to={`/library?col=${colId}&note=${it.id}`} className="aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-lg bg-muted">
              <img src={it.cover} alt="" className="size-full object-cover" />
            </Link>
            <div className="min-w-0 flex-1">
              <h3 className="truncate text-[15px] font-semibold">{it.title}</h3>
              <div className="mt-3 flex h-6 gap-0.5 overflow-hidden rounded-md">
                {v.segments.map((s, i) => (
                  <button
                    key={i}
                    type="button"
                    onMouseEnter={() => setHover((h) => ({ ...h, [it.id]: i }))}
                    className={cn("min-w-0 text-[10px] font-medium text-white transition-opacity", SEG[i % SEG.length], (hover[it.id] ?? 0) === i ? "opacity-100" : "opacity-55")}
                    style={{ flexBasis: `${((s.to - s.from) / total) * 100}%` }}
                  >
                    {s.from}s
                  </button>
                ))}
              </div>
              <p className="mt-2 min-h-5 text-sm">{cur ? `${cur.from}-${cur.to} 秒　${cur.what}` : ""}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                开头「{v.opening.line || v.opening.visual}」　{v.voiceover}　结尾：{v.ending}
              </p>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ───────── 页面 ───────── */

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
  const videoItems = a.data.visual?.filter((i) => i.video) ?? [];
  const traps = insight?.traps?.length ? insight.traps : sig.traps.map((t) => ({ title: t.title, reason: t.detail }));

  return (
    <article className="max-w-6xl space-y-10 pb-16">
      {/* 判词：整页最大的字 */}
      <header>
        {insight?.summary ? (
          <h1 className="max-w-[22em] text-[34px] font-bold leading-[1.28] tracking-tight">{insight.summary}</h1>
        ) : running ? (
          <>
            <TextShimmer className="text-[34px] font-bold leading-[1.28] tracking-tight text-muted-foreground">AI 正在解读</TextShimmer>
            <div className="mt-4 max-w-2xl">
              <AnalysisProgressView progress={a.data.progress} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">AI 没有给出结构化结论，下面是代码算出的数据。</p>
        )}
        <p className="mt-5 max-w-2xl text-sm leading-6 text-muted-foreground">
          基于 {sig.sample.total} 篇笔记，其中 {sig.sample.hit} 篇爆款、{sig.sample.withComments} 篇带评论
          {sig.sample.videos > 0 ? `、${sig.sample.videos} 个视频` : ""}。
          {a.data.positioning ? `按「${a.data.positioning}」的定位来写。` : ""}
          {lowCoverage ? "多数笔记没进详情页，结论偏保守。" : ""}
        </p>
      </header>

      {a.data.visual?.length ? (
        <Section title="爆款的封面长什么样">
          <CoverWall items={a.data.visual} colId={a.collectionId} />
        </Section>
      ) : null}

      {videoItems.length ? (
        <Section title="视频是怎么拍的">
          <VideoTimeline items={videoItems} colId={a.collectionId} />
        </Section>
      ) : null}

      {insight?.findings?.length ? (
        <Section title="哪些做法管用">
          <ul className="divide-y divide-border/60">
            {insight.findings.map((f, i) => (
              <FindingRow key={i} f={f} colId={a.collectionId} />
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title="和没火的比，差在哪">
        <div className="grid gap-x-16 gap-y-10 lg:grid-cols-2">
          <Dumbbells traits={sig.traits} />
          {sig.hooks.length > 0 && <HookSpread hooks={sig.hooks} />}
        </div>
      </Section>

      <Section title="这批笔记各是什么性格">
        <div className="grid gap-x-16 gap-y-10 lg:grid-cols-2">
          {sig.points.length >= 3 && <Personality points={sig.points} colId={a.collectionId} />}
          <div className="space-y-10">
            {sig.comments && <CommentSplit data={sig.comments} />}
            {sig.timing && (
              <div>
                <p className="mb-3 text-sm text-muted-foreground">爆款都发在周几</p>
                <WeekdayRow timing={sig.timing} />
              </div>
            )}
          </div>
        </div>
      </Section>

      {insight?.needs?.length ? (
        <Section title="观众想要，但没人给">
          <div className="grid gap-x-16 gap-y-8 md:grid-cols-2">
            {insight.needs.map((n, i) => (
              <blockquote key={i} className="border-l-2 border-primary/50 pl-5">
                <p className="text-lg leading-8">“{n.quote}”</p>
                <footer className="mt-2 text-sm text-muted-foreground">{n.need}</footer>
                <Sources colId={a.collectionId} refs={n.refs} />
              </blockquote>
            ))}
          </div>
        </Section>
      ) : null}

      {insight?.ideas?.length ? (
        <Section
          title="可以直接做的选题"
          aside={
            <button
              onClick={() => void addAll()}
              disabled={addTopic.isPending || added.size === insight.ideas.length}
              className="text-sm text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-primary hover:decoration-primary disabled:opacity-40"
            >
              全部入选题池
            </button>
          }
        >
          <ul className="divide-y divide-border/60">
            {insight.ideas.map((idea, i) => (
              <li key={i} className="grid items-start gap-x-8 gap-y-4 py-6 first:pt-0 md:grid-cols-[1fr_auto]">
                <div>
                  <h3 className="text-lg font-semibold leading-snug tracking-tight">{idea.title}</h3>
                  <p className="mt-2 text-[15px] leading-7">“{idea.hook}”</p>
                  <p className="mt-1 text-sm text-muted-foreground">{idea.angle}</p>
                  <Sources colId={a.collectionId} refs={idea.refs} />
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => addTopic.mutate(i)}
                    disabled={added.has(i) || addTopic.isPending}
                    className="flex h-9 items-center gap-1.5 rounded-full border border-border px-4 text-sm transition-colors hover:border-foreground/40 disabled:opacity-50"
                  >
                    {added.has(i) ? "已在选题池" : (<><Plus className="size-3.5" />入选题池</>)}
                  </button>
                  <button
                    onClick={() => void writeDraft(i)}
                    disabled={writingIdx === i}
                    className="flex h-9 items-center gap-1.5 rounded-full bg-primary px-4 text-sm font-medium text-primary-foreground transition-opacity disabled:opacity-60"
                  >
                    {writingIdx === i ? <Loader2 className="size-3.5 animate-spin" /> : <PenLine className="size-3.5" />}
                    {writingIdx === i ? "写稿中" : "写成草稿"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {traps.length ? (
        <Section title="看着火，但别照抄">
          <ul className="space-y-3">
            {traps.map((t, i) => (
              <li key={i} className="border-l-2 border-amber-500/60 pl-5">
                <p className="font-medium">{t.title}</p>
                <p className="mt-0.5 text-sm text-muted-foreground">{t.reason}</p>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {!insight && a.report ? <pre className="whitespace-pre-wrap rounded-lg bg-muted/50 p-5 text-sm leading-7">{a.report}</pre> : null}
    </article>
  );
}
