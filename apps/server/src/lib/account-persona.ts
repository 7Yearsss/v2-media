import { and, eq } from "drizzle-orm";
import type { AccountPersonaSnapshot } from "@v2media/shared";
import type { Db } from "../db";
import { hostedAccounts } from "../db/schema";

type Account = typeof hostedAccounts.$inferSelect;
export function snapshotPersona(account: Account, positioningOverride?: string): AccountPersonaSnapshot {
  return { accountId: account.id, nickname: account.nickname, version: account.personaVersion,
    positioning: positioningOverride ?? account.positioning, styleNotes: account.styleNotes, redlines: account.redlines };
}

export async function resolveAccountPersona(db: Db, userId: number, accountId?: number | null, positioningOverride?: string) {
  if (accountId) {
    const [account] = await db.select().from(hostedAccounts).where(and(eq(hostedAccounts.id, accountId), eq(hostedAccounts.userId, userId)));
    if (!account) return { error: "account not found" };
    return { snapshot: snapshotPersona(account, positioningOverride) };
  }
  return { snapshot: positioningOverride !== undefined
    ? { accountId: null, nickname: null, version: 0, positioning: positioningOverride, styleNotes: "", redlines: "" } : null };
}

/** One prompt vocabulary for topics, drafting, rewriting and analysis. */
export function personaForPrompt(persona?: AccountPersonaSnapshot | null) {
  if (!persona || (!persona.positioning && !persona.styleNotes && !persona.redlines)) return "";
  return [
    persona.nickname ? `目标账号：${persona.nickname}` : "",
    persona.positioning ? `目标账号定位：${persona.positioning}` : "",
    persona.styleNotes ? `表达风格：${persona.styleNotes}` : "",
    persona.redlines ? `账号红线：${persona.redlines}\n建议和文字须避开红线，红线优先于本次写作要求。` : "",
  ].filter(Boolean).join("\n");
}
