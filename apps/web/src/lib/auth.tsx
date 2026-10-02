import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  api,
  clearSession,
  captureSession,
  setSession,
  type SessionUser,
} from "@/lib/api";
import { assertCurrentSession, getSessionSnapshot, subscribeSession } from "./session";

interface AuthState {
  user: SessionUser | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const { token, user } = useSyncExternalStore(subscribeSession, getSessionSnapshot);

  const logout = useCallback(() => {
    clearSession();
  }, []);

  const apply = useCallback((nextToken: string, nextUser: SessionUser) => {
    setSession(nextToken, nextUser);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const session = captureSession();
      const res = await api.login({ email, password }, session);
      assertCurrentSession(session);
      apply(res.token, res.user);
    },
    [apply],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const session = captureSession();
      const res = await api.register({ email, password }, session);
      assertCurrentSession(session);
      apply(res.token, res.user);
    },
    [apply],
  );

  const value = useMemo(
    () => ({ user, token, login, register, logout }),
    [user, token, login, register, logout],
  );

  return <AuthCtx.Provider value={value}>{children}</AuthCtx.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}
