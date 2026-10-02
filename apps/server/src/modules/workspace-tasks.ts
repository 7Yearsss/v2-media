import type { WorkspaceTask, WorkspaceTaskBucket, WorkspaceTaskRange, WorkspaceTasksResponse } from "@v2media/shared";
import { and, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Deps } from "../context";
import { hostedAccounts } from "../db/schema";

const LIMIT = 40;
const filterSchema = z.object({ filter: z.enum(["active", "attention", "all"]).default("all"), accountId: z.coerce.number().int().positive().optional() });
interface Row {
  source: WorkspaceTask["source"]; id: number; kind: string; raw_status: string; state: WorkspaceTask["state"];
  bucket: WorkspaceTaskBucket; stage: string; created_ms: number; updated_ms: number; finished_ms: number | null;
  next_ms: number | null; next_kind: WorkspaceTask["nextCheckKind"]; account_id: number | null; account_name: string | null;
  account_archived: boolean; object_kind: NonNullable<WorkspaceTask["object"]>["type"] | null; object_id: number | null;
  object_title: string | null; object_archived: boolean; collection_id: number | null; expired: boolean;
}
const labels: Record<string, string> = {
  analysis: "采集库分析", topic_generate: "AI 选题", topic_score: "选题深评", media_upload: "图片上传", media_store: "素材转存",
  draft_generate: "AI 成稿", cover_generate: "封面生成", postmortem: "单篇复盘", readback: "发布后核对",
  metrics: "笔记指标回采", account_snapshot: "账号快照", publish: "笔记发布", collection: "关键词采集",
};
const states: Record<WorkspaceTask["state"], string> = { queued: "等待处理", running: "正在处理", paused: "已暂停", blocked: "等待人工处理",
  partial: "部分完成", done: "已完成", failed: "处理失败", canceled: "已取消", unknown: "结果待核对" };
const stages: Record<string, string> = { signals: "计算样本信号", covers: "阅读封面", videos: "阅读视频", hypotheses: "整理判断依据",
  report: "撰写报告", generating: "生成选题与评分", scoring: "深评七个维度", starting: "启动处理", retry_wait: "等待再次处理",
  search: "发现候选笔记", details: "补采详情与评论" };
const iso = (ms: number | null) => ms === null ? null : new Date(Number(ms)).toISOString();

function taskView(row: Row): WorkspaceTask {
  let href = "/", actionLabel = "查看关联页面";
  const id = row.object_id;
  switch (row.object_kind) {
    case "analysis": href = row.collection_id && id ? `/analysis?col=${row.collection_id}&report=${id}` : "/analysis"; break;
    case "collection": href = row.source === "ai_run" ? "/topics" : `/library?col=${id}`; break;
    case "topic": href = `/topics?topic=${id}`; break;
    case "draft": href = `/drafts/${id}${row.object_archived ? "?archived=1" : ""}`; break;
    case "publication": href = `/publish?job=${id}`; actionLabel = row.kind === "publish" ? "查看发布任务" : "查看发布与回采"; break;
    case "account": href = `/accounts?account=${id}${row.account_archived ? "&archived=1" : ""}`; break;
  }
  if (row.source === "collection") { href = `/collection-tasks?task=${row.id}`; actionLabel = "查看采集任务"; }
  if (row.kind === "media_store") { href = "/library"; actionLabel = "查看内容库"; }
  if (row.source === "ai_run" && !id) href = row.kind === "analysis" ? "/analysis" : "/topics";
  if (row.source === "job" && !id && row.kind !== "media_store") href = ["readback", "metrics", "postmortem"].includes(row.kind) ? "/publish" : row.kind === "account_snapshot" ? "/accounts" : "/drafts";
  const description = row.state === "unknown" && row.source === "publish"
    ? "执行租约已失效，不能据此确认未发布。请人工核对，勿直接重发。"
    : row.expired && row.state === "running" ? "执行租约已失效，等待所属执行器恢复；此处仅观察状态。"
    : row.state === "failed" ? "处理已停止，请到关联页面查看原因与可用操作。"
    : row.state === "blocked" ? "浏览器需要人工处理，请到采集任务检查登录或验证提示。"
    : row.state === "partial" ? "有详情或评论未采完整，请查看逐篇采集结果。"
    : row.state === "queued" && row.next_kind === "retry" ? "已保存任务，等待下一次自动处理。"
    : row.state === "queued" && row.next_kind === "scheduled" ? "已保存排期，实际执行还取决于浏览器和账号状态。"
    : row.state === "queued" && ["publish", "readback", "metrics", "account_snapshot", "collection"].includes(row.kind) ? "等待浏览器插件在线并领取任务。"
    : row.state === "queued" ? "任务已保存，等待服务端处理。" : states[row.state];
  return {
    key: `${row.source}:${row.id}`, id: row.id, source: row.source, kind: row.kind, label: labels[row.kind] ?? "后台任务",
    rawStatus: row.raw_status, state: row.state, bucket: row.bucket, stage: stages[row.stage] ?? states[row.state], description,
    account: row.account_id ? { id: row.account_id, nickname: row.account_name || `账号 #${row.account_id}`, archived: row.account_archived } : null,
    object: id && row.object_kind ? { type: row.object_kind, id, title: row.object_title?.trim() || `关联内容 #${id}`, archived: row.object_archived } : null,
    href, actionLabel, createdAt: iso(row.created_ms)!, updatedAt: iso(row.updated_ms)!, finishedAt: iso(row.finished_ms),
    nextCheckAt: iso(row.next_ms), nextCheckKind: row.next_kind,
  };
}

/** One observation snapshot, with independent caps for every source and priority bucket. No worker/reaper is called. */
export function workspaceTasksModule(deps: Deps) {
  const app = new Hono<{ Variables: { userId: number } }>();
  app.get("/tasks", async c => {
    const parsed = filterSchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: "任务筛选参数无效" }, 400);
    const { filter, accountId } = parsed.data, userId = c.get("userId"), now = deps.now(), nowIso = now.toISOString();
    if (accountId) {
      const [account] = await deps.db.select({ id: hostedAccounts.id }).from(hostedAccounts).where(and(eq(hostedAccounts.id, accountId), eq(hostedAccounts.userId, userId)));
      if (!account) return c.json({ error: "账号不存在" }, 404);
    }
    // Only identifiers are extracted from private JSON. Every referenced row is joined with its own user scope.
    const result = await deps.db.execute(sql`WITH base AS (
      SELECT 'ai_run'::text source, r.id, r.kind, r.status raw_status, r.status state, r.stage,
        extract(epoch FROM r.created_at)*1000 created_ms, extract(epoch FROM r.updated_at)*1000 updated_ms,
        extract(epoch FROM r.finished_at)*1000 finished_ms,
        extract(epoch FROM CASE WHEN r.status='queued' THEN r.next_attempt_at WHEN r.status='running' AND r.lease_until>${nowIso} THEN r.lease_until END)*1000 next_ms,
        CASE WHEN r.status='queued' AND r.next_attempt_at IS NOT NULL THEN 'retry' WHEN r.status='running' AND r.lease_until>${nowIso} THEN 'lease' END next_kind,
        a.id account_id, a.nickname account_name, a.archived_at IS NOT NULL account_archived,
        CASE WHEN an.id IS NOT NULL THEN 'analysis' WHEN t.id IS NOT NULL THEN 'topic' WHEN cl.id IS NOT NULL THEN 'collection' END object_kind,
        coalesce(an.id,t.id,cl.id) object_id, coalesce(cl.name,t.title) object_title, false object_archived, cl.id collection_id,
        r.status='running' AND (r.lease_until IS NULL OR r.lease_until<=${nowIso}) expired
      FROM ai_runs r
      LEFT JOIN collection_analyses an ON r.target_type='analysis' AND an.id=r.target_id AND an.user_id=${userId}
      LEFT JOIN topics t ON r.target_type='topic' AND t.id=r.target_id AND t.user_id=${userId}
      LEFT JOIN collections cl ON cl.user_id=${userId} AND cl.id=CASE WHEN r.target_type='collection' THEN r.target_id ELSE an.collection_id END
      LEFT JOIN hosted_accounts a ON a.user_id=${userId} AND a.id::text=coalesce(r.frozen_input->>'accountId',r.frozen_input->'persona'->>'accountId')
      WHERE r.user_id=${userId}
      UNION ALL
      SELECT 'job', j.id, j.type, j.status,
        CASE WHEN j.status IN ('pending','queued') THEN 'queued' WHEN j.status IN ('running','processing') THEN 'running'
          WHEN j.status IN ('done','failed','canceled') THEN j.status ELSE 'unknown' END, '' stage,
        extract(epoch FROM j.created_at)*1000, extract(epoch FROM coalesce(j.finished_at,j.claimed_at,j.created_at))*1000,
        extract(epoch FROM j.finished_at)*1000,
        extract(epoch FROM CASE WHEN j.status IN ('pending','queued') THEN j.due_at WHEN j.status='running' AND j.lease_until>${nowIso} THEN j.lease_until END)*1000,
        CASE WHEN j.status IN ('pending','queued') AND j.due_at IS NOT NULL THEN CASE WHEN j.type IN ('readback','metrics','account_snapshot') THEN 'scheduled' ELSE 'retry' END
          WHEN j.status='running' AND j.lease_until>${nowIso} THEN 'lease' END,
        a.id, a.nickname, a.archived_at IS NOT NULL,
        CASE WHEN p.id IS NOT NULL THEN 'publication' WHEN d.id IS NOT NULL THEN 'draft' WHEN a.id IS NOT NULL THEN 'account' END,
        coalesce(p.id,d.id,a.id), coalesce(p.draft_snapshot->>'title',d.title,a.nickname), d.archived_at IS NOT NULL, NULL::integer,
        j.status='running' AND (j.lease_until IS NULL OR j.lease_until<=${nowIso})
      FROM jobs j
      LEFT JOIN media_assets m ON m.user_id=${userId} AND m.id::text=j.payload->>'assetId'
      LEFT JOIN drafts d ON d.user_id=${userId} AND d.id::text=coalesce(j.payload->>'draftId',m.draft_id::text)
      LEFT JOIN postmortem_reports pr ON pr.user_id=${userId} AND pr.id::text=j.payload->>'reportId'
      LEFT JOIN publish_jobs p ON p.user_id=${userId} AND p.id::text=coalesce(j.payload->>'publishJobId',pr.publish_job_id::text)
      LEFT JOIN hosted_accounts a ON a.user_id=${userId} AND a.id::text=coalesce(j.payload->>'accountId',j.payload->'source'->'persona'->>'accountId',p.account_id::text,d.account_id::text)
      WHERE j.user_id=${userId} AND j.type IN ('media_upload','media_store','draft_generate','cover_generate','postmortem','readback','metrics','account_snapshot')
      UNION ALL
      SELECT 'publish', p.id, 'publish', p.status,
        CASE WHEN p.status='pending' THEN 'queued' WHEN p.status='running' AND (p.lease_until IS NULL OR p.lease_until<=${nowIso}) THEN 'unknown'
          WHEN p.status IN ('running','done','failed','canceled') THEN p.status ELSE 'unknown' END, '',
        extract(epoch FROM p.created_at)*1000, extract(epoch FROM p.updated_at)*1000,
        extract(epoch FROM CASE WHEN p.status IN ('done','failed','canceled') THEN p.updated_at END)*1000,
        extract(epoch FROM CASE WHEN p.status='pending' THEN p.scheduled_at WHEN p.status='running' AND p.lease_until>${nowIso} THEN p.lease_until END)*1000,
        CASE WHEN p.status='pending' AND p.scheduled_at IS NOT NULL THEN 'scheduled' WHEN p.status='running' AND p.lease_until>${nowIso} THEN 'lease' END,
        a.id, coalesce(p.account_snapshot->>'nickname',a.nickname), a.archived_at IS NOT NULL,
        'publication', p.id, coalesce(p.draft_snapshot->>'title',d.title), d.archived_at IS NOT NULL, NULL::integer,
        p.status='running' AND (p.lease_until IS NULL OR p.lease_until<=${nowIso})
      FROM publish_jobs p
      LEFT JOIN hosted_accounts a ON a.user_id=${userId} AND a.id=p.account_id
      LEFT JOIN drafts d ON d.user_id=${userId} AND d.id=p.draft_id
      WHERE p.user_id=${userId}
      UNION ALL
      SELECT 'collection', ct.id, 'collection', ct.status, ct.status, ct.phase,
        extract(epoch FROM ct.created_at)*1000, extract(epoch FROM ct.updated_at)*1000,
        extract(epoch FROM CASE WHEN ct.status IN ('done','partial','failed','canceled') THEN ct.updated_at END)*1000,
        extract(epoch FROM CASE WHEN ct.status='running' AND ct.lease_until>${nowIso} THEN ct.lease_until END)*1000,
        CASE WHEN ct.status='running' AND ct.lease_until>${nowIso} THEN 'lease' END,
        NULL::integer, NULL::text, false, CASE WHEN cl.id IS NOT NULL THEN 'collection' END, cl.id,
        cl.name, false, cl.id, ct.status='running' AND (ct.lease_until IS NULL OR ct.lease_until<=${nowIso})
      FROM collection_tasks ct LEFT JOIN collections cl ON cl.user_id=${userId} AND cl.id=ct.collection_id
      WHERE ct.user_id=${userId}
    ), scoped AS (
      SELECT *, CASE WHEN state IN ('queued','running','paused') THEN 'active' WHEN state IN ('failed','blocked','partial','unknown') THEN 'attention' ELSE 'completed' END bucket
      FROM base WHERE (${accountId ?? null}::integer IS NULL OR account_id=${accountId ?? null})
    ), ranked AS (
      SELECT *, row_number() OVER (PARTITION BY source,bucket ORDER BY created_ms DESC,id DESC) ordinal FROM scoped
      WHERE ${filter}='all' OR bucket=${filter}
    ), selected AS (SELECT * FROM ranked WHERE ordinal<=${LIMIT}), totals AS (
      SELECT source,bucket,count(*)::integer total FROM scoped GROUP BY source,bucket
    ) SELECT coalesce((SELECT jsonb_agg(to_jsonb(s)-'ordinal' ORDER BY CASE bucket WHEN 'attention' THEN 0 WHEN 'active' THEN 1 ELSE 2 END,created_ms DESC,id DESC) FROM selected s),'[]'::jsonb) items,
      coalesce((SELECT jsonb_agg(to_jsonb(t)) FROM totals t),'[]'::jsonb) totals,
      CASE WHEN EXISTS(SELECT 1 FROM ranked WHERE state='running' OR (state='queued' AND (next_ms IS NULL OR next_ms<=${now.getTime()}))) THEN 5000
        WHEN EXISTS(SELECT 1 FROM ranked WHERE state='queued') THEN 30000 ELSE NULL END refresh_ms`) as { rows: Array<{ items: Row[]; totals: Array<{ source: WorkspaceTask["source"]; bucket: WorkspaceTaskBucket; total: number }>; refresh_ms: number | null }> };
    const snapshot = result.rows[0]!, items = snapshot.items.map(taskView);
    const counts = { active: 0, attention: 0, completed: 0 };
    const ranges: WorkspaceTaskRange[] = [];
    for (const total of snapshot.totals) {
      counts[total.bucket] += total.total;
      if (filter !== "all" && total.bucket !== filter) continue;
      const returned = items.filter(item => item.source === total.source && item.bucket === total.bucket).length;
      ranges.push({ ...total, returned, truncated: returned < total.total });
    }
    const response: WorkspaceTasksResponse = { items, filter, accountId: accountId ?? null, observedAt: now.toISOString(), counts,
      ranges, perSourceBucketLimit: LIMIT, truncated: ranges.some(range => range.truncated), refreshAfterMs: snapshot.refresh_ms };
    return c.json(response);
  });
  return app;
}
