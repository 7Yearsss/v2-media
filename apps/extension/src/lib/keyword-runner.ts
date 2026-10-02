import { COLLECTION_CAPABILITY, markXhsCollectionUrl, xhsCollectionUrl, type CollectionTaskClaim, type CollectionPageSnapshot, type CollectionTask, type NoteCard } from "@v2media/shared";
interface Driver {
  api<T>(path: string, body?: unknown): Promise<T>; ownerId(): Promise<string>; enabled(): Promise<boolean>;
  reserve(owner: string): Promise<boolean>; release(owner: string): void; priorityWaiting(): Promise<boolean>;
  open(url: string): Promise<number>; close(id: number): Promise<void>; focus(id: number): Promise<void>;
  page(id: number, lease: string, action: "read" | "scroll", noteId?: string): Promise<CollectionPageSnapshot>;
  sleep(ms: number): Promise<void>; now(): number; block(taskId: number, leaseId: string): Promise<void>;
}
class PageBlocked extends Error {}
export class KeywordRunner {
  private busy = false;
  constructor(private d: Driver) {}
  async run() {
    if (this.busy || !(await this.d.enabled())) return;
    this.busy = true; const owner = "keyword"; let reserved = false, claim: CollectionTaskClaim | null = null, tabId: number | undefined, keepTab = false;
    try {
      if (await this.d.priorityWaiting() || !(await this.d.reserve(owner))) return; reserved = true;
      claim = (await this.d.api<{ claim: CollectionTaskClaim | null }>("/api/ext/collection-tasks/claim", { capability: COLLECTION_CAPABILITY, claimedBy: await this.d.ownerId() })).claim;
      if (!claim) return;
      const active = claim;
      const lease = { leaseId: active.leaseId, revision: active.task.revision };
      const path = `/api/ext/collection-tasks/${active.task.id}`;
      const started = this.d.now();
      const refresh = async () => {
        if (!(await this.d.enabled()) || await this.d.priorityWaiting()) {
          await this.d.api(`${path}/finish`, { ...lease, outcome: "yield", reason: "让位给发布/到期回采，或插件停用" }); return false;
        }
        if (this.d.now() - started > 30 * 60_000) { await this.d.api(`${path}/finish`, { ...lease, outcome: "failed", reason: "本轮达到 30 分钟执行上限，可继续恢复进度" }); return false; }
        const current = await this.d.api<{ task: CollectionTask }>(`${path}/heartbeat`, lease); active.task = current.task; return true;
      };
      const check = (snapshot: CollectionPageSnapshot) => { if (snapshot.state !== "ready") throw new PageBlocked(snapshot.reason ?? "请处理小红书登录或验证后继续"); return snapshot; };
      const open = async (url: string) => { tabId = await this.d.open(url); await this.d.sleep(3000); };
      const read = async (action: "read" | "scroll", noteId?: string) => {
        let error: unknown;
        // Content scripts can lag behind the completed navigation; bounded wait, never a navigation retry around CAPTCHA.
        for (let i = 0; i < 3; i++) { try { return check(await this.d.page(tabId!, active.leaseId, action, noteId)); }
          catch (e) { if (e instanceof PageBlocked) throw e; error = e; await this.d.sleep(1000); } }
        throw error;
      };
      if (active.task.phase === "search") {
        await open(xhsCollectionUrl(active.task.keyword, active.task.id, active.leaseId));
        // Replay only bounded scroll positions. Server note IDs remain the canonical checkpoint.
        for (let i = 0; i < active.task.scrollSteps; i++) { if (!(await refresh())) return; await read("scroll"); await this.d.sleep(active.task.intervalMs); }
        let stagnant = 0, known = new Set<string>(), scroll = active.task.scrollSteps;
        while (active.task.phase === "search") {
          if (!(await refresh())) return;
          const snapshot = await read("read");
          if (snapshot.keyword !== active.task.keyword) throw new PageBlocked("搜索页面关键词发生变化，请回工作台确认任务");
          const cards = snapshot.cards.filter(c => !known.has(c.noteId)); for (const c of cards) known.add(c.noteId);
          stagnant = cards.length ? 0 : stagnant + 1;
          // Server enforces scan/save limits and idempotency even if a page repeats data.
          for (let offset = 0; offset < Math.max(1, cards.length); offset += 50) {
            const result = await this.d.api<{ task: CollectionTask; pending: Array<{ noteId: string; card: NoteCard }> }>(`${path}/discover`,
              { ...lease, cards: cards.slice(offset, offset + 50), scrollSteps: scroll, exhausted: snapshot.exhausted || stagnant >= 3 || scroll >= 50 });
            active.task = result.task; active.pending = result.pending;
            if (active.task.phase !== "search") break;
          }
          if (active.task.phase === "search") { await read("scroll"); scroll++; await this.d.sleep(active.task.intervalMs); }
        }
        await this.d.close(tabId!); tabId = undefined;
      }
      for (const item of active.pending) {
        if (active.task.counts.saved >= active.task.saveLimit && !active.task.counts.partial) break;
        if (!(await refresh())) return;
        try {
          await open(markXhsCollectionUrl(item.card.url, active.task.id, active.leaseId));
          let snapshot = await read("read", item.noteId);
          for (let round = 0; round < 6; round++) {
            if (!(await refresh())) return;
            const count = (snapshot.detail?.commentsData ?? []).reduce((n, c) => n + 1 + (c.subComments?.length ?? 0), 0);
            if (snapshot.detail && (!active.task.commentLimit || snapshot.commentsHasMore === false || count >= active.task.commentLimit)) break;
            await read("scroll", item.noteId); await this.d.sleep(active.task.intervalMs);
            snapshot = await read("read", item.noteId);
          }
          // Re-check controls before transmission. A pause/cancel racing this POST is rejected under the server task lock.
          if (!(await refresh())) return;
          await this.d.api(`${path}/item`, { ...lease, noteId: item.noteId, detail: snapshot.detail,
            commentsHasMore: snapshot.commentsHasMore, ...(!snapshot.detail ? { error: "页面没有返回笔记详情" } : {}) });
        } catch (e) {
          if (e instanceof PageBlocked) throw e;
          await this.d.api(`${path}/item`, { ...lease, noteId: item.noteId, error: String(e).slice(0, 1000) });
        }
        if (tabId !== undefined) { await this.d.close(tabId); tabId = undefined; }
        if (!(await refresh())) return; await this.d.sleep(active.task.intervalMs);
      }
      if (await refresh()) await this.d.api(`${path}/finish`, { ...lease, outcome: "done" });
    } catch (e) {
      if (claim) {
        const blocked = e instanceof PageBlocked;
        try {
          await this.d.api(`/api/ext/collection-tasks/${claim.task.id}/finish`, { leaseId: claim.leaseId, revision: claim.task.revision,
            outcome: blocked ? "blocked" : "failed", reason: String(e instanceof Error ? e.message : e).slice(0, 1000) });
          if (blocked) { await this.d.block(claim.task.id, claim.leaseId); if (tabId !== undefined) { await this.d.focus(tabId); keepTab = true; } }
        } catch { /* Lost/canceled lease: no late writes, no resurrection. */ }
      }
    } finally {
      if (tabId !== undefined && !keepTab) await this.d.close(tabId).catch(() => {});
      if (reserved) this.d.release(owner); this.busy = false;
    }
  }
}
