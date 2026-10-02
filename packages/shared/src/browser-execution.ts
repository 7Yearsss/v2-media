/** Versioned browser execution fencing. Domain phase/state remains owned by each task. */
export const BROWSER_EXECUTION_CAPABILITY = "browser-execution-v2" as const;

/** Local platform result: uncertainty must not become a retryable server failure. */
export type PublishExecutionOutcome = "done" | "failed" | "uncertain";
export interface BrowserExecutionLease {
  claimedBy: string;
  leaseId: string;
  attempt: number;
  leaseUntil: string;
}
export interface BrowserExecutionClaimRequest {
  capability: typeof BROWSER_EXECUTION_CAPABILITY;
  claimedBy: string;
}
export interface BrowserExecutionReceipt {
  capability: typeof BROWSER_EXECUTION_CAPABILITY;
  claimedBy: string;
  leaseId: string;
  attempt: number;
  /** Persist before transmitting; retransmission must reuse this ID and body. */
  receiptId: string;
}
export interface BrowserExecutionHeartbeat {
  capability: typeof BROWSER_EXECUTION_CAPABILITY;
  claimedBy: string;
  leaseId: string;
  attempt: number;
}
export interface BrowserReceiptAck { ok: true; duplicate?: boolean; rescheduled?: boolean }
