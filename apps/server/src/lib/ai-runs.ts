import { createHash, randomUUID } from "node:crypto";
import type { AiRun, AiRunKind, AiRunResult } from "@v2media/shared";
import { and, asc, eq, gt, lte, or, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Deps } from "../context";
import type { Db } from "../db";
import { aiRunCommands, aiRuns } from "../db/schema";
import { assertWritable, isReadOnly } from "./runtime-policy";

export type AiRunRow = typeof aiRuns.$inferSelect;
export interface AiRunControls {
  progress(stage: string, steps?: string[]): Promise<void>;
  assertActive(): Promise<void>;
}
export interface AiRunHandler {
  execute(run: AiRunRow, controls: AiRunControls): Promise<unknown>;
  /** Owns the domain write in the same transaction as the terminal fenced run. */
  apply(tx: Db, run: AiRunRow, result: unknown): Promise<AiRunResult | null>;
  check?(tx: Db, run: AiRunRow): Promise<boolean>;
  fail?(tx: Db, run: AiRunRow, publicMessage: string): Promise<void>;
  retry?(tx: Db, run: AiRunRow): Promise<boolean>;
  cancel?(tx: Db, run: AiRunRow): Promise<void>;
}
export type AiRunHandlers = Partial<Record<AiRunKind, AiRunHandler>>;

export class AiRunConflict extends Error {
  constructor() { super("同一操作 ID 已用于其他 AI 请求"); }
}
export class AiRunObsolete extends Error {
  constructor() { super("AI 执行代次或目标已失效"); }
}
const errorMessages = {
  ai_failed: "AI 服务暂时不可用，请稍后重试",
  ai_timeout: "AI 执行超时，请重试",
  invalid_output: "AI 返回格式无效，请重试",
  worker_interrupted: "AI 执行中断，正在恢复",
  target_obsolete: "来源、内容或写作账号已变化，本次 AI 结果已停止",
  canceled: "已取消 AI 任务",
} as const;
export class AiRunError extends Error {
  constructor(public readonly code: "ai_failed" | "ai_timeout" | "invalid_output", publicMessage?: string, public readonly retryable = code !== "invalid_output") {
    super(publicMessage?.slice(0, 300) || errorMessages[code]);
  }
}
export const AI_RUN_LEASE_MS = 120_000;
export const AI_RUN_TIMEOUT_MS = 12 * 60_000;
const retryDelay = (attempt: number) => Math.min(60_000, Math.max(1, attempt) * 30_000);

/** JSON round-trip normalizes dates/undefined; key order must not change operation identity. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonical(item)]));
  return value;
}
function frozenJson(value: unknown) {
  const encoded = JSON.stringify(value);
  if (!encoded || Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw new Error("AI snapshot exceeds the allowed size");
  return JSON.parse(encoded) as unknown;
}
export function aiRunHash(value: unknown) { return createHash("sha256").update(JSON.stringify(canonical(frozenJson(value)))).digest("hex"); }

/** Call in the same transaction BEFORE creating a domain row for a replayable operation. */
export async function findAiRunOperation(tx: Db, userId: number, operationId: string | undefined, kind: AiRunKind, request: unknown): Promise<AiRunRow | null> {
  if (!operationId) return null;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-run:${userId}:${operationId}`}, 0))`);
  const [run] = await tx.select().from(aiRuns).where(and(eq(aiRuns.userId, userId), eq(aiRuns.operationId, operationId))).limit(1);
  if (!run) return null;
  if (run.kind !== kind || run.requestHash !== aiRunHash(request)) throw new AiRunConflict();
  return run;
}
export async function enqueueAiRun(tx: Db, input: {
  userId: number; operationId?: string; kind: AiRunKind; targetType: AiRunRow["targetType"]; targetId: number;
  request: unknown; input: unknown; model: string; promptVersion: string; now?: Date;
}): Promise<AiRunRow> {
  const existing = await findAiRunOperation(tx, input.userId, input.operationId, input.kind, input.request);
  if (existing) return existing;
  const now = input.now ?? new Date();
  const frozenInput = frozenJson(input.input);
  const [run] = await tx.insert(aiRuns).values({
    userId: input.userId, operationId: input.operationId ?? randomUUID(), kind: input.kind,
    targetType: input.targetType, targetId: input.targetId, requestHash: aiRunHash(input.request), inputHash: aiRunHash(frozenInput), frozenInput,
    model: input.model, promptVersion: input.promptVersion, createdAt: now, updatedAt: now,
  }).returning();
  return run!;
}

export function aiRunView(run: AiRunRow): AiRun {
  return {
    id: run.id, kind: run.kind, targetType: run.targetType, targetId: run.targetId, model: run.model, promptVersion: run.promptVersion,
    status: run.status, stage: run.stage, progress: run.progress, attempt: run.attempt, maxAttempts: run.maxAttempts, result: run.result ? safeResult(run.kind, run.result) : null,
    errorCode: run.errorCode, errorMessage: run.errorMessage, nextAttemptAt: run.nextAttemptAt?.toISOString() ?? null,
    createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
const resultSchemas = {
  analysis: z.object({ analysisId: z.number().int().positive(), collectionId: z.number().int().positive() }),
  topic_generate: z.object({ collectionId: z.number().int().positive(), topicIds: z.array(z.number().int().positive()).min(1).max(10), count: z.number().int().min(1).max(10) })
    .refine(result => result.count === result.topicIds.length && new Set(result.topicIds).size === result.count),
  topic_score: z.object({ topicId: z.number().int().positive(), score: z.number().int().min(0).max(100), verdict: z.enum(["做", "改方向", "不做"]), advice: z.string().max(4000) }),
};
function safeResult(kind: AiRunKind, result: unknown): AiRunResult {
  const parsed = resultSchemas[kind].safeParse(result);
  if (!parsed.success) throw new AiRunError("invalid_output");
  return parsed.data;
}
const activeWhere = (run: AiRunRow, now: Date) => and(eq(aiRuns.id, run.id), eq(aiRuns.userId, run.userId), eq(aiRuns.status, "running"),
  eq(aiRuns.attempt, run.attempt), eq(aiRuns.leaseId, run.leaseId!), gt(aiRuns.leaseUntil, now));
function active(run: AiRunRow, claimed: AiRunRow, now: Date) {
  return run.status === "running" && run.attempt === claimed.attempt && run.leaseId === claimed.leaseId && !!run.leaseUntil && run.leaseUntil > now;
}
async function lockRun(tx: Db, id: number) {
  const [row] = await tx.select().from(aiRuns).where(eq(aiRuns.id, id)).for("update").limit(1);
  return row;
}
async function cancelObsolete(tx: Db, run: AiRunRow, handler: AiRunHandler | undefined, now: Date) {
  await handler?.cancel?.(tx, run);
  await tx.update(aiRuns).set({ status: "canceled", stage: "canceled", errorCode: "target_obsolete", errorMessage: errorMessages.target_obsolete,
    leaseId: null, leaseUntil: null, nextAttemptAt: null, updatedAt: now, finishedAt: now }).where(eq(aiRuns.id, run.id));
}

/** Recovery is worker-owned. GET requests never change persisted execution state. */
export async function recoverAiRuns(deps: Deps, handlers: AiRunHandlers) {
  if (isReadOnly(deps)) return;
  const expired = await deps.db.select({ id: aiRuns.id }).from(aiRuns).where(and(eq(aiRuns.status, "running"), lte(aiRuns.leaseUntil, deps.now()))).orderBy(asc(aiRuns.id)).limit(50);
  for (const item of expired) await deps.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const run = await lockRun(tx, item.id);
    const now = deps.now();
    if (!run || run.status !== "running" || !run.leaseUntil || run.leaseUntil > now) return;
    const handler = handlers[run.kind];
    if (!handler || (handler.check && !await handler.check(tx, run))) { await cancelObsolete(tx, run, handler, now); return; }
    const exhausted = run.attempt >= run.maxAttempts;
    if (exhausted) await handler.fail?.(tx, run, "AI 多次执行中断，请手动重试");
    await tx.update(aiRuns).set({ status: exhausted ? "failed" : "queued", stage: exhausted ? "failed" : "retry_wait",
      errorCode: "worker_interrupted", errorMessage: exhausted ? "AI 多次执行中断，请手动重试" : errorMessages.worker_interrupted,
      leaseId: null, leaseUntil: null, nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelay(run.attempt)), updatedAt: now, finishedAt: exhausted ? now : null,
    }).where(eq(aiRuns.id, run.id));
  });
}

export async function claimAiRun(deps: Deps, handlers: AiRunHandlers): Promise<AiRunRow | null> {
  if (isReadOnly(deps)) return null;
  return deps.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const now = deps.now();
    const [run] = await tx.select().from(aiRuns).where(and(eq(aiRuns.status, "queued"), or(isNull(aiRuns.nextAttemptAt), lte(aiRuns.nextAttemptAt, now))))
      .orderBy(asc(aiRuns.id)).for("update", { skipLocked: true }).limit(1);
    if (!run) return null;
    const handler = handlers[run.kind];
    if (!handler || (handler.check && !await handler.check(tx, run))) { await cancelObsolete(tx, run, handler, now); return null; }
    const [claimed] = await tx.update(aiRuns).set({ status: "running", stage: "starting", errorCode: null, errorMessage: null, nextAttemptAt: null,
      attempt: run.attempt + 1, leaseId: randomUUID(), leaseUntil: new Date(now.getTime() + AI_RUN_LEASE_MS), startedAt: now, updatedAt: now,
    }).where(and(eq(aiRuns.id, run.id), eq(aiRuns.status, "queued"))).returning();
    return claimed ?? null;
  });
}
export async function renewAiRunLease(deps: Deps, run: AiRunRow): Promise<boolean> {
  if (isReadOnly(deps)) return false;
  const now = deps.now();
  if (!run.startedAt || now.getTime() - run.startedAt.getTime() >= AI_RUN_TIMEOUT_MS) return false;
  const [row] = await deps.db.update(aiRuns).set({ leaseUntil: new Date(Math.min(now.getTime() + AI_RUN_LEASE_MS, run.startedAt.getTime() + AI_RUN_TIMEOUT_MS)), updatedAt: now })
    .where(activeWhere(run, now)).returning({ id: aiRuns.id });
  return !!row;
}

/** One independently claimable job; a restarted worker needs only durable DB state. */
export async function runAiJobs(deps: Deps, handlers: AiRunHandlers): Promise<boolean> {
  if (isReadOnly(deps)) return false;
  await recoverAiRuns(deps, handlers);
  const run = await claimAiRun(deps, handlers);
  if (!run) return false;
  const handler = handlers[run.kind]!;
  const controls: AiRunControls = {
    async assertActive() {
      const [current] = await deps.db.select({ id: aiRuns.id }).from(aiRuns).where(activeWhere(run, deps.now())).limit(1);
      if (!current) throw new AiRunObsolete();
    },
    async progress(stage, steps = []) {
      const now = deps.now();
      const [written] = await deps.db.update(aiRuns).set({ stage: stage.slice(0, 64), progress: { steps: steps.slice(0, 20).map(step => step.slice(0, 64)), at: now.toISOString() }, updatedAt: now })
        .where(activeWhere(run, now)).returning({ id: aiRuns.id });
      if (!written) throw new AiRunObsolete();
    },
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const heartbeat = setInterval(() => void renewAiRunLease(deps, run).catch(() => false), 20_000).unref();
  try {
    const result = await Promise.race([
      handler.execute(run, controls),
      new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new AiRunError("ai_timeout")), AI_RUN_TIMEOUT_MS); timeout.unref(); }),
    ]);
    await deps.db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const current = await lockRun(tx, run.id);
      const now = deps.now();
      if (!current || !active(current, run, now)) return;
      const summary = await handler.apply(tx, current, result);
      if (summary === null) { await cancelObsolete(tx, current, handler, now); return; }
      const publicResult = safeResult(run.kind, summary);
      const finished = deps.now();
      // Domain writes roll back too if the lease expired while applying the result.
      if (!active(current, run, finished)) throw new AiRunObsolete();
      await tx.update(aiRuns).set({ status: "done", stage: "done", result: publicResult, errorCode: null, errorMessage: null,
        leaseId: null, leaseUntil: null, nextAttemptAt: null, updatedAt: finished, finishedAt: finished }).where(activeWhere(run, finished));
    });
  } catch (error) {
    if (error instanceof AiRunObsolete) {
      await deps.db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const current = await lockRun(tx, run.id);
        const now = deps.now();
        if (current && active(current, run, now) && (!handler.check || !await handler.check(tx, current))) await cancelObsolete(tx, current, handler, now);
      });
      return true;
    }
    const code = error instanceof AiRunError ? error.code : "ai_failed";
    const message = error instanceof AiRunError ? error.message : errorMessages.ai_failed;
    await deps.db.transaction(async transaction => {
      const tx = transaction as unknown as Db;
      const current = await lockRun(tx, run.id);
      const now = deps.now();
      if (!current || !active(current, run, now)) return;
      if (handler.check && !await handler.check(tx, current)) { await cancelObsolete(tx, current, handler, now); return; }
      const exhausted = current.attempt >= current.maxAttempts || (error instanceof AiRunError && !error.retryable);
      if (exhausted) await handler.fail?.(tx, current, message);
      await tx.update(aiRuns).set({ status: exhausted ? "failed" : "queued", stage: exhausted ? "failed" : "retry_wait", errorCode: code, errorMessage: message,
        leaseId: null, leaseUntil: null, nextAttemptAt: exhausted ? null : new Date(now.getTime() + retryDelay(current.attempt)), updatedAt: now, finishedAt: exhausted ? now : null,
      }).where(activeWhere(run, now));
    });
  } finally {
    clearInterval(heartbeat);
    if (timeout) clearTimeout(timeout);
  }
  return true;
}
export function startAiWorker(deps: Deps, handlers: AiRunHandlers) {
  if (isReadOnly(deps)) return;
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runAiJobs(deps, handlers); } catch { console.warn("AI worker failed; durable lease will recover"); } finally { busy = false; }
  };
  void tick();
  return setInterval(() => void tick(), 2000).unref();
}

export async function retryAiRun(deps: Deps, handlers: AiRunHandlers, userId: number, id: number, requestedOperationId?: string): Promise<{ run?: AiRunRow; error?: string; code: 202 | 404 | 409 }> {
  assertWritable(deps);
  const operationId = requestedOperationId ?? randomUUID();
  return deps.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ai-command:${userId}:${operationId}`}, 0))`);
    const [command] = await tx.select().from(aiRunCommands).where(and(eq(aiRunCommands.userId, userId), eq(aiRunCommands.operationId, operationId))).limit(1);
    if (command && (command.runId !== id || command.action !== "retry")) return { error: "同一操作 ID 已用于其他 AI 操作", code: 409 };
    const run = await lockRun(tx, id);
    if (!run || run.userId !== userId) return { error: "AI 任务不存在", code: 404 };
    if (command) return { run, code: 202 };
    if (run.status === "queued") {
      await tx.insert(aiRunCommands).values({ userId, operationId, runId: id, createdAt: deps.now() });
      return { run, code: 202 };
    }
    if (run.status !== "failed") return { error: "仅失败的 AI 任务可重试", code: 409 };
    const handler = handlers[run.kind];
    if (!handler || (handler.check && !await handler.check(tx, run)) || (handler.retry && !await handler.retry(tx, run))) return { error: errorMessages.target_obsolete, code: 409 };
    const [retried] = await tx.update(aiRuns).set({ status: "queued", stage: "queued", progress: null, errorCode: null, errorMessage: null,
      maxAttempts: run.attempt + 3, leaseId: null, leaseUntil: null, nextAttemptAt: null, updatedAt: deps.now(), finishedAt: null }).where(eq(aiRuns.id, id)).returning();
    await tx.insert(aiRunCommands).values({ userId, operationId, runId: id, createdAt: deps.now() });
    return { run: retried, code: 202 };
  });
}
export async function cancelAiRun(deps: Deps, handlers: AiRunHandlers, userId: number, id: number): Promise<{ run?: AiRunRow; error?: string; code: 200 | 404 | 409 }> {
  assertWritable(deps);
  return deps.db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const run = await lockRun(tx, id);
    if (!run || run.userId !== userId) return { error: "AI 任务不存在", code: 404 };
    if (run.status === "canceled") return { run, code: 200 };
    if (run.status === "done" || run.status === "failed") return { error: "此 AI 任务已结束", code: 409 };
    await handlers[run.kind]?.cancel?.(tx, run);
    const now = deps.now();
    const [canceled] = await tx.update(aiRuns).set({ status: "canceled", stage: "canceled", errorCode: "canceled", errorMessage: errorMessages.canceled,
      leaseId: null, leaseUntil: null, nextAttemptAt: null, updatedAt: now, finishedAt: now }).where(eq(aiRuns.id, id)).returning();
    return { run: canceled, code: 200 };
  });
}
