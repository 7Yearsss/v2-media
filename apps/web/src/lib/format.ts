import type { CollectSource, PublishJobStatus } from "@v2media/shared";
import type { AnimatedBadgeStatus } from "@/components/motion/animated-badge";

/** 小红书风格计数：1.2万 / 3.4亿。 */
export function formatCount(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 100_000_000) return `${trim((n / 100_000_000).toFixed(1))}亿`;
  if (n >= 10_000) return `${trim((n / 10_000).toFixed(1))}万`;
  return n.toLocaleString();
}

function trim(s: string): string {
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

export function timeAgo(input?: string | number | null): string {
  if (!input) return "—";
  const t = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(t)) return "—";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return new Date(t).toLocaleDateString("zh-CN");
}

export function fmtDateTime(input?: string | number | null): string {
  if (!input) return "立即";
  const t = typeof input === "number" ? input : Date.parse(input);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export const SOURCE_LABEL: Record<CollectSource | "all", string> = {
  all: "全部",
  homefeed: "首页",
  search: "搜索",
  user_posted: "主页",
  collect_page: "收藏",
  like_page: "点赞",
  detail: "详情",
};

export const JOB_STATUS_META: Record<
  PublishJobStatus,
  { label: string; status: AnimatedBadgeStatus }
> = {
  pending: { label: "待执行", status: "info" },
  claimed: { label: "已认领", status: "loading" },
  running: { label: "执行中", status: "loading" },
  done: { label: "已发布", status: "success" },
  failed: { label: "失败", status: "danger" },
  canceled: { label: "已取消", status: "neutral" },
};

export const ACCOUNT_STATUS_META: Record<
  string,
  { label: string; status: AnimatedBadgeStatus }
> = {
  online: { label: "在线", status: "success" },
  stale: { label: "心跳超时", status: "warning" },
  expired: { label: "登录失效", status: "danger" },
  unknown: { label: "未知", status: "neutral" },
};

export const VISIBILITY_LABEL: Record<string, string> = {
  public: "公开",
  friends: "仅好友可见",
  private: "仅自己可见",
};
