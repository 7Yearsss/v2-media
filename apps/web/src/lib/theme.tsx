import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark" | "system";
type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "theme";
const MQ = "(prefers-color-scheme: dark)";

const systemIsDark = () => window.matchMedia(MQ).matches;

interface ThemeValue {
  theme: Theme;
  resolvedTheme: ResolvedTheme;
  setTheme: (t: Theme) => void;
}

const ThemeCtx = createContext<ThemeValue | null>(null);

/** SPA 主题 Provider：替换 next-themes（它为 SSR 注入 <script>，SPA 里只会刷 React 警告）。 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    try {
      return (localStorage.getItem(STORAGE_KEY) as Theme | null) ?? "light";
    } catch {
      return "light";
    }
  });
  const [sysDark, setSysDark] = useState(systemIsDark);

  useEffect(() => {
    const mq = window.matchMedia(MQ);
    const fn = (e: MediaQueryListEvent) => setSysDark(e.matches);
    mq.addEventListener("change", fn);
    return () => mq.removeEventListener("change", fn);
  }, []);

  const resolvedTheme: ResolvedTheme =
    theme === "system" ? (sysDark ? "dark" : "light") : theme;

  useEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("dark", resolvedTheme === "dark");
    root.style.colorScheme = resolvedTheme;
  }, [resolvedTheme]);

  const value = useMemo<ThemeValue>(
    () => ({
      theme,
      resolvedTheme,
      setTheme: (t: Theme) => {
        try {
          localStorage.setItem(STORAGE_KEY, t);
        } catch {
          /* private mode */
        }
        setThemeState(t);
      },
    }),
    [theme, resolvedTheme],
  );

  return <ThemeCtx.Provider value={value}>{children}</ThemeCtx.Provider>;
}

export function useTheme(): ThemeValue {
  const ctx = useContext(ThemeCtx);
  if (!ctx) throw new Error("useTheme 必须在 ThemeProvider 内");
  return ctx;
}
