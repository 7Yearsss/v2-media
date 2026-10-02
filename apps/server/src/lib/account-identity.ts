import { sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db";
import { hostedAccounts } from "../db/schema";

/** A heartbeat can observe a profile, but cannot edit its persona or restore an archive. */
export const observedAccountSchema = z.object({
  xhsUserId: z.string().trim().min(1).max(128).regex(/^[^\s\u0000-\u001f\u007f]+$/u),
  nickname: z.string().max(128).default(""),
  avatar: z.string().max(10000).default(""),
  subType: z.enum(["pc", "creator"]).default("pc"),
  status: z.enum(["online", "expired"]).default("online"),
  statusMessage: z.string().max(5000).optional(),
});
export type ObservedAccount = z.infer<typeof observedAccountSchema>;

/** UPSERT owns the identity row lock until the caller's transaction commits. */
export async function observeAccount(db: Db, userId: number, observed: ObservedAccount, now: Date) {
  const [account] = await db.insert(hostedAccounts).values({
    userId, platform: "xhs", ...observed, statusMessage: observed.statusMessage ?? "", lastSeenAt: now,
  }).onConflictDoUpdate({
    target: [hostedAccounts.userId, hostedAccounts.platform, hostedAccounts.subType, hostedAccounts.xhsUserId],
    set: {
      nickname: observed.nickname ? observed.nickname : sql`${hostedAccounts.nickname}`,
      avatar: observed.avatar ? observed.avatar : sql`${hostedAccounts.avatar}`,
      status: observed.status,
      statusMessage: observed.statusMessage ?? "",
      lastSeenAt: now,
    },
  }).returning();
  if (!account) throw new Error("Account identity UPSERT returned no account");
  return account;
}
