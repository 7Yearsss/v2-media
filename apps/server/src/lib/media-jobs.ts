import { and, eq, inArray, isNull, lt, lte, or } from "drizzle-orm";
import type { Deps } from "../context";
import { collectedNotes, jobs } from "../db/schema";
import { persistCollectedMedia } from "./media-store";

interface Payload { noteIds: number[]; base: string; attempts?: number }

/** Durable server-only states avoid exposing downloads to extension workers. */
export async function enqueueMediaJob(deps: Deps, userId: number, noteIds: number[], base: string) {
  if (!deps.r2 || !noteIds.length || !base) return;
  await deps.db.insert(jobs).values({ userId, type: "media_store", status: "queued", payload: { noteIds, base } });
}

export async function runMediaJobs(deps: Deps) {
  if (!deps.r2) return;
  const now = deps.now();
  await deps.db.update(jobs).set({ status: "queued", claimedAt: null }).where(and(
    eq(jobs.type, "media_store"), eq(jobs.status, "processing"), lt(jobs.claimedAt, new Date(now.getTime() - 20 * 60_000)),
  ));
  const [job] = await deps.db.select().from(jobs).where(and(
    eq(jobs.type, "media_store"), eq(jobs.status, "queued"), or(isNull(jobs.dueAt), lte(jobs.dueAt, now)),
  )).orderBy(jobs.id).limit(1);
  if (!job) return;
  const [claimed] = await deps.db.update(jobs).set({ status: "processing", claimedAt: now }).where(and(
    eq(jobs.id, job.id), eq(jobs.status, "queued"),
  )).returning();
  if (!claimed) return;
  const payload = job.payload as Payload;
  try {
    // Validate ownership again when executing, including recovered jobs.
    const rows = await deps.db.select({ id: collectedNotes.id }).from(collectedNotes).where(and(
      eq(collectedNotes.userId, job.userId), inArray(collectedNotes.id, payload.noteIds),
    ));
    await persistCollectedMedia(deps, rows.map(row => row.id), payload.base);
    await deps.db.update(jobs).set({ status: "done", finishedAt: deps.now(), error: null }).where(eq(jobs.id, job.id));
  } catch (error) {
    const attempts = (payload.attempts ?? 0) + 1;
    await deps.db.update(jobs).set({
      status: attempts < 3 ? "queued" : "failed", payload: { ...payload, attempts },
      dueAt: new Date(deps.now().getTime() + attempts * 30_000), error: String(error),
    }).where(eq(jobs.id, job.id));
  }
}

export function startMediaWorker(deps: Deps) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try { await runMediaJobs(deps); } catch (error) { console.warn("media worker failed", error); }
    finally { busy = false; }
  };
  void tick();
  return setInterval(() => void tick(), 2000).unref();
}
