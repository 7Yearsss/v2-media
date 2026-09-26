import { Layers, Loader2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { Navigate, useNavigate } from "react-router-dom";
import { motion } from "motion/react";
import { Button } from "@/components/motion/button";
import { Input } from "@/components/motion/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/motion/tabs";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { SPRING_PANEL } from "@/lib/ease";

export default function LoginPage() {
  const { token, login, register } = useAuth();
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
    <div className="relative flex min-h-dvh items-center justify-center bg-background px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle
          variant="circle-blur"
          className="size-8 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          iconClassName="size-4"
        />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={SPRING_PANEL}
        className="w-full max-w-sm"
      >
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <div className="grid size-11 place-items-center rounded-2xl bg-primary text-primary-foreground shadow-lg shadow-primary/20">
            <Layers className="size-5" />
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-foreground">
              v2-media 工作台
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              小红书一站式运营平台
            </p>
          </div>
        </div>

        <div className="rounded-3xl border border-border bg-card p-6 shadow-sm">
          <Tabs
            value={mode}
            onValueChange={(v) => {
              setMode(v as "login" | "register");
              setError(null);
            }}
            variant="segment"
            className="mb-6"
          >
            <TabsList className="w-full">
              <TabsTrigger value="login" className="flex-1">
                登录
              </TabsTrigger>
              <TabsTrigger value="register" className="flex-1">
                注册
              </TabsTrigger>
            </TabsList>
          </Tabs>

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
              className="mt-1 w-full"
              disabled={pending}
            >
              {pending ? (
                <Loader2 className="size-4 animate-spin" aria-hidden />
              ) : null}
              {mode === "login" ? "登录" : "创建账号"}
            </Button>
          </form>
        </div>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          采集与发布由浏览器插件完成，登录后在「账号矩阵」授权插件
        </p>
      </motion.div>
    </div>
  );
}
