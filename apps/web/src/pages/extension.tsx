import {
  CheckCircle2,
  Chrome,
  Download,
  FolderOpen,
  Loader2,
  LogIn,
  Puzzle,
  ToggleRight,
  XCircle,
  Zap,
} from "lucide-react";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { ButtonLink } from "@/components/motion/button";
import { TiltCard } from "@/components/motion/tilt-card";
import { useExtensionStatus } from "@/components/app/app-shell";

const STEPS = [
  {
    icon: Download,
    title: "下载并解压",
    desc: "下载插件包并解压。",
  },
  {
    icon: ToggleRight,
    title: "开启开发者模式",
    desc: "Chrome 地址栏输入 chrome://extensions，打开右上角「开发者模式」。",
  },
  {
    icon: FolderOpen,
    title: "加载已解压的扩展程序",
    desc: "点击左上角「加载已解压的扩展程序」，选择刚才解压的文件夹。",
  },
  {
    icon: LogIn,
    title: "登录小红书并授权",
    desc: "登录 xiaohongshu.com，在「账号」页授权插件。",
  },
];

export default function ExtensionPage() {
  const { online } = useExtensionStatus();
  return (
    <div className="workspace-page">
      <div className="mb-4 flex flex-wrap items-center justify-end gap-3">
        <AnimatedBadge
          size="sm"
          status={online === true ? "success" : online === false ? "warning" : "info"}
          pulse={online === true}
        >
          {online === true ? (
            "插件已连接"
          ) : online === false ? (
            "未检测到插件"
          ) : (
            <Loader2 className="size-3 animate-spin" />
          )}
        </AnimatedBadge>
      </div>

      <div className="grid gap-4 lg:grid-cols-5">
        <TiltCard max={0} className="lg:col-span-2">
          <div className="flex h-full flex-col gap-4 rounded-2xl border border-border bg-card p-6">
            <span className="grid size-11 place-items-center rounded-xl bg-primary/15 text-primary">
              <Puzzle className="size-5" />
            </span>
            <div>
              <h3 className="text-base font-semibold text-foreground">
                v2-media 插件
              </h3>
              <p className="mt-1 text-sm leading-6 text-muted-foreground">
                小红书采集与发布
              </p>
            </div>
            <div className="mt-auto flex flex-col gap-2">
              <ButtonLink href="/extension.zip" download="v2-media-extension.zip">
                <Download className="size-4" />
                下载插件
              </ButtonLink>
              <p className="text-xs text-muted-foreground">
                Chrome 扩展 · ZIP
              </p>
            </div>
          </div>
        </TiltCard>

        <div className="rounded-2xl border border-border bg-card p-6 lg:col-span-3">
          <h3 className="mb-4 text-base font-semibold text-foreground">
            安装步骤
          </h3>
          <ol className="space-y-4">
            {STEPS.map((s, i) => (
              <li key={s.title} className="flex gap-3">
                <span className="grid size-7 shrink-0 place-items-center rounded-full border border-border text-xs font-semibold text-muted-foreground">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium text-foreground">
                    <s.icon className="size-4 text-primary" />
                    {s.title}
                  </p>
                  <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
                    {s.desc}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </div>

      <div className="mt-4 flex items-start gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-xs leading-5 text-muted-foreground">
        <Chrome className="mt-0.5 size-4 shrink-0" />
        <p>
          {online === true ? (
            <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-3.5" />
              已连接。可在「账号」页核对授权与登录状态。
            </span>
          ) : online === false ? (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              <XCircle className="size-3.5" />
              未检测到插件。安装后刷新页面，在「账号」页授权。
            </span>
          ) : (
            "正在检测插件连接…"
          )}
        </p>
        <Zap className="mt-0.5 ml-auto size-4 shrink-0 text-primary" />
      </div>
    </div>
  );
}
