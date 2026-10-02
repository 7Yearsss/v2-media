import { and, eq, sql } from "drizzle-orm";
import type { AccountPersonaSnapshot, CollectionAnalysisStats } from "@v2media/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { aiRuns, collectionAnalyses, collections, hostedAccounts } from "../db/schema";
import { AiRunError, AiRunObsolete, type AiRunHandler, type AiRunRow } from "./ai-runs";
import { runAnalysisAI, type RunInput } from "./analysis-run";
import { isUsableInsight, parseInsight } from "./insight-parse";

export interface AnalysisAiInput {
  collectionId: number;
  accountId: number | null;
  executionRevision: number | null;
  stats: CollectionAnalysisStats;
  persona: AccountPersonaSnapshot | null;
  positioning: string;
  input: RunInput;
}
const snapshot = (run: AiRunRow) => run.frozenInput as unknown as AnalysisAiInput;
async function validTarget(db: Db, run: AiRunRow, lock = false) {
  const input = snapshot(run);
  if (lock) await db.execute(sql`SELECT id FROM collections WHERE id=${input.collectionId} AND user_id=${run.userId} FOR SHARE`);
  const [collection] = await db.select({ id: collections.id }).from(collections).where(and(eq(collections.id, input.collectionId), eq(collections.userId, run.userId)));
  if (!collection) return false;
  if (input.accountId) {
    if (lock) await db.execute(sql`SELECT id FROM hosted_accounts WHERE id=${input.accountId} AND user_id=${run.userId} FOR SHARE`);
    const [account] = await db.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, input.accountId), eq(hostedAccounts.userId, run.userId)));
    if (!account || account.archivedAt || account.executionRevision !== input.executionRevision) return false;
  }
  const [analysis] = await db.select().from(collectionAnalyses).where(and(eq(collectionAnalyses.id, run.targetId), eq(collectionAnalyses.userId, run.userId)));
  return !!analysis && analysis.collectionId === input.collectionId && analysis.aiRunId === run.id && analysis.status === (run.status === "failed" ? "failed" : "running");
}
const personaData = (input: AnalysisAiInput) => ({ persona: input.persona, ...(input.positioning ? { positioning: input.positioning } : {}) });
function revive(input: RunInput): RunInput {
  const note = (n: RunInput["pool"][number]) => ({ ...n, publishedAt: n.publishedAt ? new Date(n.publishedAt) : null });
  return { ...input, now: new Date(input.now), pool: input.pool.map(note), sample: input.sample.map(note) };
}

export function createAnalysisAiRunHandler(deps: Deps): AiRunHandler {
  return {
    check: (db, run) => validTarget(db, run),
    async execute(run, controls) {
      const frozen = snapshot(run);
      const assertTarget = async () => {
        await controls.assertActive();
        if (!(await validTarget(deps.db, run))) throw new AiRunObsolete();
      };
      const scoped: Deps = { ...deps, ai: { async complete(system, user, options) {
        await assertTarget(); const text = await deps.ai.complete(system, user, options); await assertTarget(); return text;
      } } };
      await assertTarget();
      const result = await runAnalysisAI(scoped, { ...revive(frozen.input), assertActive: assertTarget, onStage: async (stage, steps) => {
        await assertTarget(); await controls.progress(stage, steps);
        const now = deps.now();
        await deps.db.update(collectionAnalyses).set({ data: { stats: frozen.stats, insight: null, ...personaData(frozen), progress: { stage, steps, at: now.getTime() } } })
          .where(and(eq(collectionAnalyses.id, run.targetId), eq(collectionAnalyses.userId, run.userId), eq(collectionAnalyses.aiRunId, run.id), eq(collectionAnalyses.status, "running"),
            sql`EXISTS (SELECT 1 FROM ai_runs WHERE id=${run.id} AND user_id=${run.userId} AND status='running' AND attempt=${run.attempt} AND lease_id=${run.leaseId} AND lease_until>${now.toISOString()})`));
      } });
      const byRef = new Map(frozen.input.pool.map(n => [n.ref, { id: n.id, title: n.title }]));
      const insight = parseInsight(result.report, value => {
        const id = Number(String(value).replace(/\D/g, "")); return Number.isInteger(id) ? byRef.get(id) ?? null : null;
      });
      if (!insight || (!insight.summary.trim() && !insight.findings?.length && !insight.ideas?.length)) throw new AiRunError("invalid_output");
      return { ...result, insight, warnings: isUsableInsight(insight) ? [] : ["报告结构覆盖不足，建议需结合样本人工核对"] };
    },
    async apply(tx, run, output) {
      if (!(await validTarget(tx, run, true))) return null;
      const input = snapshot(run), result = output as Awaited<ReturnType<typeof runAnalysisAI>> & { insight: NonNullable<ReturnType<typeof parseInsight>>; warnings: string[] };
      const [written] = await tx.update(collectionAnalyses).set({ status: "done", error: null, report: result.report,
        data: { stats: input.stats, insight: result.insight, ...personaData(input), ...(result.visual.length ? { visual: result.visual } : {}), ...(result.warnings.length ? { warnings: result.warnings } : {}) } })
        .where(and(eq(collectionAnalyses.id, run.targetId), eq(collectionAnalyses.userId, run.userId), eq(collectionAnalyses.aiRunId, run.id), eq(collectionAnalyses.status, "running"))).returning({ id: collectionAnalyses.id });
      return written ? { analysisId: written.id, collectionId: input.collectionId } : null;
    },
    async fail(tx, run, message) {
      await tx.update(collectionAnalyses).set({ status: "failed", error: message }).where(and(eq(collectionAnalyses.id, run.targetId), eq(collectionAnalyses.userId, run.userId), eq(collectionAnalyses.aiRunId, run.id), eq(collectionAnalyses.status, "running")));
    },
    async cancel(tx, run) {
      await tx.update(collectionAnalyses).set({ status: "failed", error: "本次分析已停止" }).where(and(eq(collectionAnalyses.id, run.targetId), eq(collectionAnalyses.userId, run.userId), eq(collectionAnalyses.aiRunId, run.id), eq(collectionAnalyses.status, "running")));
    },
    async retry(tx, run) {
      const input = snapshot(run);
      const [collection] = await tx.select().from(collections).where(and(eq(collections.id, input.collectionId), eq(collections.userId, run.userId)));
      const [analysis] = await tx.select().from(collectionAnalyses).where(and(eq(collectionAnalyses.id, run.targetId), eq(collectionAnalyses.userId, run.userId)));
      if (!collection || !analysis || analysis.aiRunId !== run.id || analysis.status !== "failed") return false;
      if (input.accountId) {
        const [account] = await tx.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, input.accountId), eq(hostedAccounts.userId, run.userId)));
        if (!account || account.archivedAt || account.executionRevision !== input.executionRevision) return false;
      }
      await tx.update(collectionAnalyses).set({ status: "running", error: null, data: { stats: input.stats, insight: null, ...personaData(input) } }).where(eq(collectionAnalyses.id, analysis.id));
      return true;
    },
  };
}
