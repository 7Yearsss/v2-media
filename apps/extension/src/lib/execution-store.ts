import type { BrowserExecutionLease } from "@v2media/shared";

/** An execution remembers its authority, never a second copy of a bearer token. */
export interface ExecutionContext { apiBase: string; epoch: string }
export interface BrowserExecution {
  kind: "publish" | "task" | "keyword";
  id: number;
  context: ExecutionContext;
  lease?: BrowserExecutionLease;
  tabId?: number;
  deadline: number;
  payload: unknown;
  delivered?: boolean;
  phase?: "opening" | "running" | "awaiting_ack" | "uncertain" | "authorization_changed";
}
export interface ResultReceipt {
  key: string;
  kind: BrowserExecution["kind"];
  id: number;
  context: ExecutionContext;
  path: string;
  body: Record<string, unknown>;
}
export class ExecutionStore {
  private tail: Promise<unknown> = Promise.resolve();
  private update<T>(run: () => Promise<T>): Promise<T> {
    const next = this.tail.then(run, run); this.tail = next.catch(() => {}); return next;
  }
  async executions(): Promise<BrowserExecution[]> {
    await this.tail; return (await chrome.storage.local.get("browserExecutions")).browserExecutions ?? [];
  }
  put(record: BrowserExecution) {
    return this.update(async () => {
      const records: BrowserExecution[] = (await chrome.storage.local.get("browserExecutions")).browserExecutions ?? [];
      await chrome.storage.local.set({ browserExecutions: [...records.filter(r => r.kind !== record.kind || r.id !== record.id), record] });
    });
  }
  remove(kind: BrowserExecution["kind"], id: number, expected?: BrowserExecution) {
    return this.update(async () => {
      const records: BrowserExecution[] = (await chrome.storage.local.get("browserExecutions")).browserExecutions ?? [];
      const current = records.find(r => r.kind === kind && r.id === id);
      if (expected && current && (current.context.epoch !== expected.context.epoch || current.context.apiBase !== expected.context.apiBase || current.lease?.leaseId !== expected.lease?.leaseId)) return false;
      await chrome.storage.local.set({ browserExecutions: records.filter(r => r.kind !== kind || r.id !== id) });
      return true;
    });
  }
  async receipts(): Promise<ResultReceipt[]> {
    await this.tail; return (await chrome.storage.local.get("browserResultOutbox")).browserResultOutbox ?? [];
  }
  enqueue(receipt: ResultReceipt): Promise<ResultReceipt> {
    return this.update(async () => {
      const rows: ResultReceipt[] = (await chrome.storage.local.get("browserResultOutbox")).browserResultOutbox ?? [];
      const old = rows.find(r => r.key === receipt.key); if (old) return old;
      await chrome.storage.local.set({ browserResultOutbox: [...rows, receipt] }); return receipt;
    });
  }
  ack(key: string) {
    return this.update(async () => {
      const rows: ResultReceipt[] = (await chrome.storage.local.get("browserResultOutbox")).browserResultOutbox ?? [];
      await chrome.storage.local.set({ browserResultOutbox: rows.filter(r => r.key !== key) });
    });
  }
}
