import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  api,
  clearSession,
  getStoredUser,
  getToken,
  setSession,
  UNAUTHORIZED_EVENT,
  type SessionUser,
} from "@/lib/api";

interface AuthState {
  user: SessionUser | null;
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthCtx = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() => getToken());
  const [user, setUser] = useState<SessionUser | null>(() => getStoredUser());

  const logout = useCallback(() => {
    clearSession();
    setToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    const onExpire = () => logout();
    window.addEventListener(UNAUTHORIZED_EVENT, onExpire);
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onExpire);
  }, [logout]);

  const apply = useCallback((nextToken: string, nextUser: SessionUser) => {
    setSession(nextToken, nextUser);
    setToken(nextToken);
    setUser(nextUser);
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      const res = await api.login({ email, password });
      apply(res.token, res.user);
    },
    [apply],
  );

  const register = useCallback(
    async (email: string, password: string) => {
      const res = await api.register({ email, password });
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
