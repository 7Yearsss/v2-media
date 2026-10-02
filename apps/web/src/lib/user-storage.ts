import { captureSession, isCurrentSession, type SessionContext } from "./session";

export function userStorageKey(namespace: string, session: SessionContext): string | null {
  return session.user ? `${namespace}:user:${session.user.id}` : null;
}

/** Capture once per mounted session. Legacy unscoped values have no attributable owner. */
export function captureUserStorage(namespace: string) {
  const session = captureSession();
  const key = userStorageKey(namespace, session);
  return Object.freeze({
    key,
    getItem(): string | null {
      if (!key || !isCurrentSession(session)) return null;
      try { return localStorage.getItem(key); } catch { return null; }
    },
    setItem(value: string): boolean {
      if (!key || !isCurrentSession(session)) return false;
      try { localStorage.setItem(key, value); return true; } catch { return false; }
    },
  });
}
