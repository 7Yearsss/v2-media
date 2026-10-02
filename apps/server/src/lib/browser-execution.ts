import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { BROWSER_EXECUTION_CAPABILITY } from "@v2media/shared";
import type { Db } from "../db";
import { browserExecutionReceipts } from "../db/schema";

export const publishLeaseMs = 10 * 60_000;
export const attributionLeaseMs = 2 * 60_000;
export const browserClaimSchema = z.object({ capability: z.literal(BROWSER_EXECUTION_CAPABILITY), claimedBy: z.string().trim().min(1).max(128) });
export const browserHeartbeatSchema = browserClaimSchema.extend({ leaseId: z.string().uuid(), attempt: z.number().int().positive() });
export const browserReceiptFields = browserHeartbeatSchema.extend({ receiptId: z.string().uuid() });
export const supportsBrowserExecution = (body: unknown) => !!body && typeof body === "object" && (body as Record<string, unknown>).capability === BROWSER_EXECUTION_CAPABILITY;
export const capabilityError = { error: "browser-execution-v2 required; update extension before executing tasks" };

type LeaseRow = { status: string; claimedBy: string | null; leaseId: string | null; attempt: number; leaseUntil: Date | null };
export function hasLiveLease(row: LeaseRow, now: Date) { return row.status === "running" && !!row.claimedBy && !!row.leaseId && row.attempt > 0 && !!row.leaseUntil && row.leaseUntil.getTime() > now.getTime(); }
export function matchesLease(row: LeaseRow, claimed: z.infer<typeof browserHeartbeatSchema>, now: Date) {
  return hasLiveLease(row, now) && row.claimedBy === claimed.claimedBy && row.leaseId === claimed.leaseId && row.attempt === claimed.attempt;
}
export function terminalMetadata(row: LeaseRow & { id: number }) { return { id: row.id, status: row.status, claimedBy: row.claimedBy, leaseId: row.leaseId, attempt: row.attempt, leaseUntil: row.leaseUntil }; }

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]));
  return value;
}
export const receiptHash = (body: unknown) => createHash("sha256").update(JSON.stringify(canonical(body))).digest("hex");
type ReceiptDb = Pick<Db, "execute" | "select" | "insert">;
/** Lock receipt identity first, then the execution row. Same receipt cannot have effects on two jobs. */
export async function replayReceipt(tx: ReceiptDb, userId: number, domain: "publish" | "tasks", executionId: number, receiptId: string, bodyHash: string) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${userId}:${receiptId}`}, 0))`);
  const [row] = await tx.select().from(browserExecutionReceipts).where(and(eq(browserExecutionReceipts.userId, userId), eq(browserExecutionReceipts.receiptId, receiptId)));
  if (!row) return null;
  return row.domain === domain && row.executionId === executionId && row.bodyHash === bodyHash
    ? { ack: row.ack }
    : { error: "receiptId reused with different execution or body", code: 409 as const };
}
export async function saveReceipt(tx: ReceiptDb, userId: number, domain: "publish" | "tasks", executionId: number, receiptId: string, bodyHash: string, ack: { ok: true; rescheduled?: boolean }) {
  await tx.insert(browserExecutionReceipts).values({ userId, domain, executionId, receiptId, bodyHash, ack });
}
