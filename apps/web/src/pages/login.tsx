import { Layers, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";

export default function LoginPage() {
  const { token, login, register } = useAuth();
  const reduce = useReducedMotion();
  const navigate = useNavigate();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (token) return <Navigate to="/" replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setError(null);
    setPending(true);
    try {
      if (mode === "login") await login(email.trim(), password);
      else await register(email.trim(), password);
      navigate("/", { replace: true });
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : mode === "login"
            ? "登录失败，请检查邮箱和密码"
            : "注册失败，请稍后重试",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="auth-shell relative">
      <header className="auth-brand"><span className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground"><Layers className="size-5" /></span>v2-media</header>
      <div className="absolute right-8 top-8">
        <ThemeToggle
          variant="rectangle"
          className="size-8 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          iconClassName="size-4"
        />
      </div>

      <main className="auth-layout">
        <motion.section initial={reduce ? false : { opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: .18 }} className="auth-form">
          <h1>{mode === "login" ? "登录工作台" : "创建账号"}</h1>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <Input
              label="邮箱"
              type="email"
              required
              autoComplete="email"
              placeholder="you@example.com"
              value={email}
              onChange={setEmail}
            />
            <Input
              label="密码"
              type="password"
              required
              minLength={6}
              autoComplete={
                mode === "login" ? "current-password" : "new-password"
              }
              placeholder={mode === "register" ? "至少 6 位" : "输入密码"}
              value={password}
              onChange={setPassword}
              error={error ?? undefined}
              reserveErrorLine
            />

            <Button
              type="submit"
              size="lg"
              className="workspace-action mt-2 w-full"
              disabled={pending}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              {mode === "login" ? "登录" : "创建账号"}
            </Button>
          </form>
          <p className="mt-6 text-sm text-muted-foreground">{mode === "login" ? "还没有账号？" : "已有账号？"}<button type="button" className="ml-2 rounded font-medium text-foreground underline-offset-4 hover:underline" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(null); }}>{mode === "login" ? "创建账号" : "登录"}</button></p>
        </motion.section>
        <aside className="auth-visual" aria-label="封面示例">
          <div className="auth-cover"><p className="text-xs tracking-wide">封面示例</p><h2>周末备餐<br />三步清单</h2><ol><li>01　准备容器</li><li>02　整理食材</li><li>03　安排顺序</li></ol><span className="absolute bottom-9 left-8 text-xs">1080 × 1440</span></div>
        </aside>
      </main>
    </div>
  );
}
