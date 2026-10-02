import type { Draft, HostedAccount, PublishJob } from "@v2media/shared";
import { api, captureSession, type SessionContext } from "./api";

export interface RetrySelection { job: PublishJob; operationId: string; session: SessionContext }

/** Keep the operation and authorization when transport fails and the user tries again. */
export function selectOriginalRetry(job: PublishJob): RetrySelection {
  return { job, operationId: crypto.randomUUID(), session: captureSession() };
}

export function submitOriginalRetry(selection: RetrySelection) {
  return api.retryJob(selection.job.id, { operationId: selection.operationId }, selection.session);
}

export function publishVersionLabels(job: PublishJob, draft?: Draft, account?: HostedAccount) {
  return {
    draftTitle: job.draftSnapshot?.title || draft?.title || `草稿 #${job.draftId}`,
    accountName: job.accountSnapshot?.nickname || job.accountSnapshot?.xhsUserId || account?.nickname || account?.xhsUserId || `账号 #${job.accountId}`,
  };
}

export function comparePublishVersion(job: PublishJob, draft?: Draft, account?: HostedAccount) {
  const snapshot = job.draftSnapshot, persona = job.personaSnapshot;
  return {
    personaChanged: !!account && !!persona && (account.personaVersion !== persona.version || account.positioning !== persona.positioning || account.styleNotes !== persona.styleNotes || account.redlines !== persona.redlines),
    draftChanged: !!draft && !!snapshot && (draft.title !== snapshot.title || draft.content !== snapshot.content || JSON.stringify(draft.tags) !== JSON.stringify(snapshot.tags) || JSON.stringify(draft.images) !== JSON.stringify(snapshot.images)),
  };
}
