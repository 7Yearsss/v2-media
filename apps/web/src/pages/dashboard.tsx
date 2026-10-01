import {
  ArrowRight,
  CircleCheck,
  LibraryBig,
  NotebookPen,
  Users,
} from "lucide-react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  CompositionChart,
  type CompositionChartSeries,
} from "@/components/charts/composition-chart";
import { NumberTicker } from "@/components/motion/number-ticker";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { EmptyState, PageError, PageLoading } from "@/components/app/states";
import type { CollectSource } from "@v2media/shared";
import { api } from "@/lib/api";
import { formatCount, SOURCE_LABEL } from "@/lib/format";
import { cn } from "@/lib/utils";

const CARD_SPRING = {
  type: "spring",
  stiffness: 300,
  damping: 30,
  mass: 0.8,
} as const;

export default function DashboardPage() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview });
  const jobs = useQuery({ queryKey: ["publish-jobs"], queryFn: api.jobs });

  if (overview.isPending) return <PageLoading label="加载仪表盘…" />;
  if (overview.isError)
    return <PageError error={overview.error} onRetry={overview.refetch} />;

  const stats = overview.data;

  // 契约未定义 overview 的成功率字段时，从任务列表本地兜底计算。
  const doneJobs = (jobs.data ?? []).filter((j) => j.status === "done").length;
  const finishedJobs = (jobs.data ?? []).filter(
    (j) => j.status === "done" || j.status === "failed",
  ).length;
  const successRate =
    stats.publishSuccessRate ??
    (finishedJobs > 0 ? (doneJobs / finishedJobs) * 100 : null);

  const cards = [
    {
      label: "内容库笔记",
      value: stats.notes,
      icon: LibraryBig,
      to: "/library",
      suffix: "",
    },
    {
      label: "草稿",
      value: stats.drafts,
      icon: NotebookPen,
      to: "/drafts",
      suffix: "",
    },
    {
      label: "托管账号",
      value: stats.accounts,
      icon: Users,
      to: "/accounts",
      suffix: "",
    },
    {
      label: "发布成功率",
      value: successRate ?? 0,
      icon: CircleCheck,
      to: "/publish",
      suffix: "%",
      formatter: (v: number) => `${v.toFixed(0)}%`,
      empty: successRate === null,
    },
  ];

  const periods = stats.trend.map((t, i) => t.label || `D${i + 1}`);
  const SOURCE_COLORS: Record<string, string> = {
    search: "#e2442f",
    homefeed: "#f59e0b",
    collect_page: "#0d9488",
    like_page: "#8b5cf6",
    user_posted: "#38bdf8",
    detail: "#a1a1aa",
  };
  const series: CompositionChartSeries[] =
    stats.trendBySource.length > 0
      ? stats.trendBySource.map((s, i) => ({
          id: s.source,
          name: SOURCE_LABEL[s.source as CollectSource] ?? s.source,
          color:
            SOURCE_COLORS[s.source] ??
            ["#e2442f", "#f59e0b", "#0d9488", "#8b5cf6"][i % 4],
          values: s.values,
        }))
      : stats.trend.length > 0
        ? [
            {
              id: "collect",
              name: "采集量",
              color: "#e2442f",
              values: stats.trend.map((t) => t.count),
            },
          ]
        : [];

  return (
    <div className="w-full px-6 pb-8 pt-6">
      <div className="mb-4 flex items-center justify-end">
        {jobs.data && jobs.data.length > 0 ? (
          <AnimatedBadge size="sm" status="info">
            共 {jobs.data.length} 个发布任务
          </AnimatedBadge>
        ) : null}
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {cards.map((card, i) => (
          <motion.div
            key={card.label}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...CARD_SPRING, delay: i * 0.05 }}
          >
            <Link
              to={card.to}
              className={cn(
                "group block rounded-2xl border border-border bg-card p-5 outline-none transition-colors",
                "hover:border-foreground/20 focus-visible:ring-2 focus-visible:ring-ring",
              )}
            >
              <div className="flex items-center justify-between">
                <card.icon className="size-4 text-muted-foreground" />
                <ArrowRight className="size-3.5 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
              <p className="mt-4 text-3xl font-semibold tabular-nums tracking-tight text-foreground">
                {card.empty ? (
                  <span className="text-muted-foreground">—</span>
                ) : card.formatter ? (
                  <NumberTicker
                    value={card.value}
                    format={card.formatter}
                    className="tabular-nums"
                  />
                ) : (
                  <NumberTicker
                    value={card.value}
                    format={(v) => formatCount(v)}
                    className="tabular-nums"
                  />
                )}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">{card.label}</p>
            </Link>
          </motion.div>
        ))}
      </div>

      <div className="mt-6 rounded-3xl border border-border bg-card p-6">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              近 7 天采集趋势
            </h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              插件上报入库的笔记数量
            </p>
          </div>
        </div>
        {series.length > 0 ? (
          <CompositionChart
            view="area"
            series={series}
            periods={periods}
            label="近 7 天采集趋势"
            formatValue={(v) => `${formatCount(v)} 条`}
            className="w-full"
          />
        ) : (
          <EmptyState
            title="暂无采集数据"
            description="安装浏览器插件并在小红书页面浏览后，采集趋势会显示在这里"
            className="py-10"
          />
        )}
      </div>
    </div>
  );
}
