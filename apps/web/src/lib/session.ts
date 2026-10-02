/** One atomic authorization record. Requests retain this record until completion. */
export interface SessionUser {
  id: number;
  email: string;
}

export interface SessionContext {
  readonly epoch: number;
  readonly token: string | null;
  readonly user: Readonly<SessionUser> | null;
  readonly signal: AbortSignal;
}

const SESSION_KEY = "v2m.session";
const LEGACY_TOKEN_KEY = "v2m.token";
const LEGACY_USER_KEY = "v2m.user";
export const UNAUTHORIZED_EVENT = "v2m:unauthorized";
const listeners = new Set<() => void>();
let epoch = 0;
let controller = new AbortController();

function validUser(value: unknown): value is SessionUser {
  if (!value || typeof value !== "object") return false;
  const user = value as Partial<SessionUser>;
  return Number.isSafeInteger(user.id) && user.id! > 0 && typeof user.email === "string";
}

function readStored(): { token: string | null; user: SessionUser | null } {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    const record = raw === null
      ? { token: localStorage.getItem(LEGACY_TOKEN_KEY), user: JSON.parse(localStorage.getItem(LEGACY_USER_KEY) ?? "null") }
      : JSON.parse(raw);
    if (typeof record?.token === "string" && record.token && validUser(record.user)) {
      // Migrate an existing login once, before later two-key storage events can mix identities.
      if (raw === null) localStorage.setItem(SESSION_KEY, JSON.stringify({ token: record.token, user: record.user }));
      return { token: record.token, user: { id: record.user.id, email: record.user.email } };
    }
  } catch { /* Invalid or unavailable storage starts logged out. */ }
  return { token: null, user: null };
}

function context(record: ReturnType<typeof readStored>): SessionContext {
  return Object.freeze({ epoch: ++epoch, ...record, user: record.user && Object.freeze(record.user), signal: controller.signal });
}

let current = context(readStored());

function refresh() {
  const next = readStored();
  if (next.token === current.token && next.user?.id === current.user?.id && next.user?.email === current.user?.email) return;
  const previousController = controller;
  controller = new AbortController();
  current = context(next);
  previousController.abort();
  for (const notify of [...listeners]) notify();
}

// storage events are emitted in the other tab; same-tab writes notify below.
window.addEventListener("storage", (event: StorageEvent) => {
  if (event.key === null || event.key === SESSION_KEY || event.key === LEGACY_TOKEN_KEY || event.key === LEGACY_USER_KEY) refresh();
});

export const subscribeSession = (notify: () => void) => {
  listeners.add(notify);
  return () => { listeners.delete(notify); };
};

export const getSessionSnapshot = () => current;

export function captureSession(): SessionContext {
  // Check storage as well: another tab's storage event may still be queued.
  refresh();
  return current;
}

export function isCurrentSession(session: SessionContext): boolean {
  refresh();
  return session === current && !session.signal.aborted;
}

export class SessionChangedError extends Error {
  constructor() {
    super("登录账号已改变，已停止旧会话操作");
    this.name = "SessionChangedError";
  }
}

export function assertCurrentSession(session: SessionContext) {
  if (!isCurrentSession(session)) throw new SessionChangedError();
}

export const getToken = () => captureSession().token;
export const getStoredUser = () => captureSession().user;

export function setSession(token: string, user: SessionUser) {
  if (!token || !validUser(user)) throw new Error("Invalid authorization record");
  localStorage.setItem(SESSION_KEY, JSON.stringify({ token, user }));
  // One new record replaces the old two-key format; no half-written identity is read.
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_USER_KEY);
  refresh();
}

export function clearSession(expected?: SessionContext) {
  if (expected && !isCurrentSession(expected)) return;
  localStorage.setItem(SESSION_KEY, "null");
  localStorage.removeItem(LEGACY_TOKEN_KEY);
  localStorage.removeItem(LEGACY_USER_KEY);
  refresh();
}
