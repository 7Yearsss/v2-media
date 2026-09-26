import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { env } from "../env";

export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt:${salt}:${hash}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [kind, salt, hash] = stored.split(":");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** stateless token: userId.expiryMs.sig（HMAC-SHA256） */
export function signToken(userId: number, ttlMs = 30 * 24 * 3600 * 1000): string {
  const expiry = Date.now() + ttlMs;
  const body = `${userId}.${expiry}`;
  const sig = createHmac("sha256", env.authSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [uid, exp, sig] = parts;
  const expected = createHmac("sha256", env.authSecret).update(`${uid}.${exp}`).digest("base64url");
  const a = Buffer.from(sig ?? "");
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (Number(exp) < Date.now()) return null;
  const userId = Number(uid);
  return Number.isInteger(userId) ? userId : null;
}
