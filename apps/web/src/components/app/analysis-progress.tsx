import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AnalysisProgress, AnalysisStage } from "@v2media/shared";
import { cn } from "@/lib/utils";

const LABEL: Record<AnalysisStage, string> = {
  signals: "算信号",
  covers: "看封面",
  videos: "看视频",
  hypotheses: "提假设",
  report: "审稿成稿",
};

/** 每个阶段大致要多久（秒）：只用来让进度条走得平滑，不是承诺。 */
const EXPECT: Record<AnalysisStage, number> = { signals: 3, covers: 15, videos: 60, hypotheses: 40, report: 20 };

const HINT: Partial<Record<AnalysisStage, string>> = {
  covers: "正在看爆款的封面",
  videos: "正在看视频",
  hypotheses: "正在对比爆款和同类，找差异",
  report: "正在删掉站不住的结论",
};

const DEFAULT_STEPS: AnalysisStage[] = ["signals", "covers", "hypotheses", "report"];

/**
 * 生成中的进度：步骤条 + 一条平滑的进度条 + 已用时间。
 * 阶段由服务端写进 data.progress（页面轮询拿到）；条的位置按各阶段预估时长折算，
 * 当前阶段内用指数逼近，永远不会在阶段没结束时走到头。
 */
export function AnalysisProgressView({ progress }: { progress?: AnalysisProgress }) {
  const steps = progress?.steps ?? DEFAULT_STEPS;
  const stage = progress?.stage ?? "covers";
  const startedRef = useRef(Date.now());
  const stageAtRef = useRef(Date.now());
  const [, tick] = useState(0);

  // 阶段切换时重新计当前阶段已用时间（用本地时钟，避免和服务器时钟差）
  useEffect(() => {
    stageAtRef.current = Date.now();
  }, [stage]);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(t);
  }, []);

  const idx = Math.max(0, steps.indexOf(stage));
  const total = steps.reduce((sum, s) => sum + EXPECT[s], 0);
  const done = steps.slice(0, idx).reduce((sum, s) => sum + EXPECT[s], 0);
  const inStage = (Date.now() - stageAtRef.current) / 1000;
  const cur = EXPECT[stage] * (1 - Math.exp(-inStage / EXPECT[stage])) * 0.95;
  const pct = Math.min(96, ((done + cur) / total) * 100);
  const elapsed = Math.floor((Date.now() - startedRef.current) / 1000);

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
        {steps.map((s, i) => {
          const state = i < idx ? "done" : i === idx ? "active" : "todo";
          return (
            <span
              key={s}
              className={cn(
                "flex items-center gap-1.5 transition-colors",
                state === "todo" && "text-muted-foreground/50",
                state === "active" && "font-medium text-foreground",
                state === "done" && "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "grid size-4 place-items-center rounded-full text-[9px]",
                  state === "done" && "bg-primary text-primary-foreground",
                  state === "active" && "bg-primary/15 ring-2 ring-primary/40",
                  state === "todo" && "bg-muted",
                )}
              >
                {state === "done" ? <Check className="size-2.5" /> : state === "active" ? <i className="size-1.5 animate-pulse rounded-full bg-primary" /> : null}
              </span>
              {LABEL[s]}
            </span>
          );
        })}
        <span className="ml-auto tabular-nums text-muted-foreground">已用 {elapsed} 秒</span>
      </div>

      <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full bg-gradient-to-r from-primary/70 to-primary transition-[width] duration-700 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>

      {HINT[stage] && <div className="mt-2 text-xs text-muted-foreground">{HINT[stage]}…</div>}
    </div>
  );
}
