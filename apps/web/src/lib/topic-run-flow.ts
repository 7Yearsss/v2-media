import type { AiRun, AiRunKind } from "@v2media/shared";

export const isActiveAiRun = (run: AiRun) => run.status === "queued" || run.status === "running";
export const topicRunPollInterval = (runs: AiRun[] | undefined) => runs?.some(isActiveAiRun) ? 2000 : false;
export function latestTopicRun(runs: AiRun[], kind: AiRunKind, targetId: number) {
  return runs.filter(run => run.kind === kind && run.targetId === targetId).sort((a, b) => b.id - a.id)[0];
}
/** Retain the command identity if its HTTP acknowledgement is lost. */
export class AiOperationIds {
  private ids = new Map<string, string>();
  get(key: string) {
    const id = this.ids.get(key) ?? crypto.randomUUID();
    this.ids.set(key, id);
    return id;
  }
  accepted(key: string) { this.ids.delete(key); }
}
