import { and, eq } from "drizzle-orm";
import type { CollectionTask, CollectionTaskItem } from "@v2media/shared";
import type { Db } from "../db";
import { collectionTaskItems, collectionTasks } from "../db/schema";
export const COLLECTION_LEASE_MS = 120_000;
export const activeCollectionStatuses = ["queued", "running", "paused", "blocked"];
export function itemView(i: typeof collectionTaskItems.$inferSelect): CollectionTaskItem {
  return { id: i.id, taskId: i.taskId, noteId: i.noteId, title: i.card.title, likes: i.card.likes,
    status: i.status as CollectionTaskItem["status"], reason: i.reason, collectedNoteId: i.collectedNoteId, alreadyExisted: i.alreadyExisted,
    platformComments: i.platformComments, capturedComments: i.capturedComments, capturedReplies: i.capturedReplies,
    commentCoverage: i.commentCoverage as CollectionTaskItem["commentCoverage"] };
}
export async function taskView(db: Db, t: typeof collectionTasks.$inferSelect): Promise<CollectionTask> {
  const rows = await db.select().from(collectionTaskItems).where(eq(collectionTaskItems.taskId, t.id));
  const counts = { discovered: rows.length, skipped: 0, pending: 0, saved: 0, newNotes: 0, failed: 0, partial: 0, comments: 0, replies: 0 };
  for (const i of rows) { if (i.status === "pending") counts.pending++;
    else if (i.status === "skipped") counts.skipped++; else if (i.status === "failed") counts.failed++;
    if (i.collectedNoteId !== null) { counts.saved++; if (i.commentCoverage === "partial") counts.partial++; if (!i.alreadyExisted) counts.newNotes++; counts.comments += i.capturedComments; counts.replies += i.capturedReplies; } }
  return { ...t.rules, id: t.id, collectionName: t.collectionName, status: t.status as CollectionTask["status"], revision: t.revision,
    controlRevision: t.controlRevision, lastControlAction: t.lastControlAction as CollectionTask["lastControlAction"],
    phase: t.phase as CollectionTask["phase"], scrollSteps: t.scrollSteps, reason: t.reason,
    createdAt: t.createdAt.toISOString(), updatedAt: t.updatedAt.toISOString(), leaseUntil: t.leaseUntil?.toISOString() ?? null, counts };
}
export const ownCollectionTask = async (db: Db, userId: number, id: number) => (await db.select().from(collectionTasks)
  .where(and(eq(collectionTasks.id, id), eq(collectionTasks.userId, userId))))[0];
