import type { Draft, DraftUpdateRequest } from "@v2media/shared";

export type DraftText = Pick<Draft, "title" | "content" | "tags">;
export type DraftSaveState = "saved" | "dirty" | "saving" | "error" | "conflict";
export interface DraftEditView {
  fields: DraftText;
  state: DraftSaveState;
  error?: string;
  server?: Draft;
  recovered: boolean;
  savedAt?: number;
}
type StorageAdapter = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;
interface PersistedEdit { version: 1; baseVersion: number; base: DraftText; patch: Partial<DraftText>; changedAt: number }
interface Entry extends PersistedEdit { server: Draft; state: DraftSaveState; error?: string; recovered: boolean; savedAt?: number; source?: { key: string; value: string } }
interface Options {
  userId: number;
  writerId: string;
  storage: StorageAdapter;
  save: (id: number, patch: DraftUpdateRequest) => Promise<Draft>;
  load: (id: number) => Promise<Draft>;
  active: () => boolean;
  now?: () => number;
}
const fields = (draft: Draft): DraftText => ({ title: draft.title, content: draft.content, tags: [...draft.tags] });
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const hasPatch = (entry: Entry) => Object.keys(entry.patch).length > 0;
function parse(raw: string): PersistedEdit | null {
  try {
    const e = JSON.parse(raw);
    if (e.version !== 1 || !Number.isInteger(e.baseVersion) || e.baseVersion < 0 || !Number.isFinite(e.changedAt) ||
        typeof e.base?.title !== "string" || typeof e.base?.content !== "string" || !Array.isArray(e.base?.tags) ||
        e.base.tags.some((s: unknown) => typeof s !== "string") || !e.patch || typeof e.patch !== "object") return null;
    for (const [key, value] of Object.entries(e.patch)) {
      if (key === "tags" ? !Array.isArray(value) || value.some(s => typeof s !== "string") :
          !["title", "content"].includes(key) || typeof value !== "string") return null;
    }
    return e;
  } catch { return null; }
}

/** Owns local durability, serialization and CAS conflict handling for an authenticated editor. */
export class DraftEditSession {
  private readonly entries = new Map<number, Entry>();
  private readonly flights = new Map<number, Promise<boolean>>();
  private readonly listeners = new Set<() => void>();
  constructor(private readonly options: Options) {}
  private prefix(id: number) { return `v2m.edit.v1:${this.options.userId}:${id}:`; }
  private key(id: number) { return this.prefix(id) + this.options.writerId; }
  private emit() { for (const listener of this.listeners) listener(); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private persist(id: number, entry: Entry) {
    try {
      if (hasPatch(entry)) {
        const { baseVersion, base, patch, changedAt } = entry;
        this.options.storage.setItem(this.key(id), JSON.stringify({ version: 1, baseVersion, base, patch, changedAt } satisfies PersistedEdit));
      } else {
        this.options.storage.removeItem(this.key(id));
        // A recovered tab's edit may have changed meanwhile; never delete its newer copy.
        if (entry.source && this.options.storage.getItem(entry.source.key) === entry.source.value) this.options.storage.removeItem(entry.source.key);
        entry.source = undefined;
      }
      return true;
    } catch {
      entry.state = "error"; entry.error = "本地保存失败，请保持页面打开并重试服务器保存"; return false;
    }
  }
  private accept(id: number, entry: Entry, server: Draft) {
    entry.server = server; entry.base = fields(server); entry.baseVersion = server.textVersion;
    for (const key of Object.keys(entry.patch) as Array<keyof DraftText>) if (equal(entry.patch[key], entry.base[key])) delete entry.patch[key];
    entry.error = undefined; entry.state = hasPatch(entry) ? "dirty" : "saved";
    if (!hasPatch(entry)) entry.recovered = false;
    this.persist(id, entry);
  }
  open(server: Draft): DraftEditView {
    let entry = this.entries.get(server.id);
    if (!entry) {
      let restored: PersistedEdit | null = null, source: Entry["source"];
      try {
        for (let i = 0; i < this.options.storage.length; i++) {
          const key = this.options.storage.key(i); if (!key?.startsWith(this.prefix(server.id))) continue;
          const value = this.options.storage.getItem(key); if (!value) continue;
          const edit = parse(value); if (edit && (!restored || edit.changedAt > restored.changedAt)) { restored = edit; source = { key, value }; }
        }
      } catch { /* The first change will surface unavailable storage. */ }
      entry = { version: 1, base: restored?.base ?? fields(server), baseVersion: restored?.baseVersion ?? server.textVersion,
        patch: restored?.patch ?? {}, changedAt: restored?.changedAt ?? 0, server, state: restored ? "dirty" : "saved", recovered: !!restored, source };
      this.entries.set(server.id, entry);
      if (restored) this.persist(server.id, entry);
    }
    if (!this.flights.has(server.id) && server.textVersion >= entry.baseVersion) {
      if (!hasPatch(entry)) this.accept(server.id, entry, server);
      else if (server.textVersion !== entry.baseVersion) {
        if ((Object.keys(entry.patch) as Array<keyof DraftText>).every(key => equal(entry!.patch[key], server[key]))) this.accept(server.id, entry, server);
        else { entry.server = server; entry.state = "conflict"; entry.error = "服务器已有另一版本；本地改动已保留，请核对后选择"; }
      }
    }
    return this.view(server.id)!;
  }
  view(id: number): DraftEditView | null {
    const e = this.entries.get(id); return e ? { fields: { ...e.base, ...e.patch }, state: e.state, error: e.error,
      server: e.state === "conflict" ? e.server : undefined, recovered: e.recovered, savedAt: e.savedAt } : null;
  }
  change(id: number, patch: Partial<DraftText>): DraftEditView {
    const e = this.entries.get(id); if (!e) throw new Error("草稿尚未载入");
    Object.assign(e.patch, patch); e.changedAt = (this.options.now ?? Date.now)();
    for (const key of Object.keys(e.patch) as Array<keyof DraftText>) if (equal(e.patch[key], e.base[key])) delete e.patch[key];
    if (e.state !== "conflict") { e.state = hasPatch(e) ? "dirty" : "saved"; e.error = undefined; }
    this.persist(id, e); this.emit(); return this.view(id)!;
  }
  flush(id: number): Promise<boolean> {
    const running = this.flights.get(id); if (running) return running;
    const work = this.savePending(id); this.flights.set(id, work);
    void work.finally(() => { this.flights.delete(id); this.emit(); }); return work;
  }
  private async savePending(id: number): Promise<boolean> {
    const e = this.entries.get(id); if (!e) return true;
    if (e.state === "conflict") return false;
    while (hasPatch(e)) {
      if (!this.options.active()) { e.state = "error"; e.error = "会话已改变，本地改动保留在原用户下"; this.emit(); return false; }
      e.state = "saving"; e.error = undefined; this.emit();
      const patch = structuredClone(e.patch);
      try {
        const saved = await this.options.save(id, { textVersion: e.baseVersion, ...patch });
        if (!this.options.active()) throw new Error("会话已改变，本地改动保留在原用户下");
        this.accept(id, e, saved); e.savedAt = (this.options.now ?? Date.now)();
      } catch (error) {
        if ((error as { status?: number }).status === 409 && this.options.active()) {
          try {
            const latest = await this.options.load(id);
            if (!this.options.active()) throw new Error("会话已改变");
            if ((Object.keys(e.patch) as Array<keyof DraftText>).every(key => equal(e.patch[key], latest[key]))) {
              this.accept(id, e, latest); this.emit(); continue;
            }
            e.server = latest;
          } catch { /* Keep the patch even if reading the conflict also fails. */ }
          e.state = "conflict"; e.error = "服务器已有另一版本；本地改动已保留，请核对后选择";
        } else { e.state = "error"; e.error = error instanceof Error ? error.message : "保存失败，本地改动已保留"; }
        this.persist(id, e); this.emit(); return false;
      }
      this.emit();
    }
    return e.state === "saved";
  }
  /** Explicit decision after showing server text; another race is still guarded by CAS. */
  async resolve(id: number, choice: "local" | "server"): Promise<boolean> {
    if (!this.options.active()) return false;
    const e = this.entries.get(id); if (!e) return true;
    try {
      const latest = await this.options.load(id); if (!this.options.active()) return false;
      if (choice === "server") e.patch = {};
      this.accept(id, e, latest); this.emit();
      return choice === "server" ? true : this.flush(id);
    } catch (error) { e.state = "conflict"; e.error = error instanceof Error ? error.message : "无法读取最新版本"; this.emit(); return false; }
  }
  forget(id: number) {
    const e = this.entries.get(id); if (e) { e.patch = {}; this.persist(id, e); }
    this.entries.delete(id); this.emit();
  }
}
