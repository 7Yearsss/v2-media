import type { NoteCard, NoteDetail } from "./types";
export const COLLECTION_CAPABILITY = "xhs-keyword-v1" as const;
export type CollectionTaskStatus = "queued" | "running" | "paused" | "blocked" | "done" | "partial" | "failed" | "canceled";
export interface CollectionTaskRules {
  keyword: string; collectionId: number; minLikes: number; scanLimit: number; saveLimit: number;
  commentLimit: number; intervalMs: number;
}
export interface CollectionTask extends CollectionTaskRules {
  id: number; collectionName: string; status: CollectionTaskStatus; revision: number;
  phase: "search" | "details"; scrollSteps: number; reason: string | null;
  createdAt: string; updatedAt: string; leaseUntil: string | null;
  counts: { discovered: number; skipped: number; pending: number; saved: number; newNotes: number; failed: number; partial: number; comments: number; replies: number };
}
export interface CollectionTaskItem {
  id: number; taskId: number; noteId: string; title: string; likes: number;
  status: "pending" | "skipped" | "saved" | "partial" | "failed";
  reason: string | null; collectedNoteId: number | null; alreadyExisted: boolean;
  platformComments: number | null; capturedComments: number; capturedReplies: number;
  commentCoverage: "not_requested" | "none" | "partial" | "complete";
}
export interface CollectionTaskDetail { task: CollectionTask; items: CollectionTaskItem[]; nextOffset: number | null }
export interface CollectionTaskClaim {
  task: CollectionTask; leaseId: string; pending: Array<{ noteId: string; card: NoteCard }>;
}
export interface CollectionLease { leaseId: string; revision: number }
export interface CollectionDiscoverRequest extends CollectionLease { cards: NoteCard[]; scrollSteps: number; exhausted?: boolean }
export interface CollectionItemRequest extends CollectionLease {
  noteId: string; detail?: NoteDetail; commentsHasMore?: boolean; error?: string;
}
export interface CollectionControlRequest { revision: number; action: "pause" | "resume" | "cancel" }
export interface CollectionPageSnapshot {
  state: "ready" | "blocked" | "login_required"; reason?: string; keyword?: string;
  cards: NoteCard[]; detail?: NoteDetail; commentsHasMore?: boolean; exhausted: boolean;
}
export interface CollectionPageCommand { type: "COLLECTION_PAGE"; leaseId: string; action: "read" | "scroll"; noteId?: string }
