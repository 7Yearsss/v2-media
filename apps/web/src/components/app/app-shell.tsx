import {
  Bell,
  ChartNoAxesCombined,
  BrainCircuit,
  ChevronsUpDown,
  Layers,
  LayoutDashboard,
  LibraryBig,
  Lightbulb,
  LogOut,
  NotebookPen,
  PanelLeft,
  Plus,
  Puzzle,
  SendHorizontal,
  Sparkles,
  Users,
  X,
  Zap,
} from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarHeader,
  AnimatedSidebarInset,
  AnimatedSidebarMenu,
  AnimatedSidebarMenuButton,
  AnimatedSidebarMenuItem,
  AnimatedSidebarProvider,
  AnimatedSidebarRail,
  AnimatedSidebarTrigger,
  AnimatedSidebarClose,
} from "@/components/motion/animated-sidebar";
import { AnimatedBadge } from "@/components/motion/animated-badge";
import { Button } from "@/components/motion/button";
import {
  CommandPalette,
  type CommandItem,
} from "@/components/motion/command-palette";
import {
  NotificationStack,
  type NotificationStackItem,
} from "@/components/motion/notification-stack";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { api, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bridge, useExtensionOnline } from "@/lib/bridge";
import { JOB_STATUS_META } from "@/lib/format";
import { useToast } from "@/lib/toast";

const NAV = [
  { to: "/", label: "仪表盘", icon: LayoutDashboard, match: /^\/$/ },
  { to: "/library", label: "内容库", icon: LibraryBig, match: /^\/library/ },
  { to: "/analysis", label: "AI 分析", icon: BrainCircuit, match: /^\/analysis/ },
  { to: "/topics", label: "选题池", icon: Lightbulb, match: /^\/topics/ },
  { to: "/drafts", label: "草稿工坊", icon: NotebookPen, match: /^\/drafts/ },
  { to: "/accounts", label: "账号矩阵", icon: Users, match: /^\/accounts/ },
  { to: "/publish", label: "发布中心", icon: SendHorizontal, match: /^\/publish/ },
  { to: "/insights", label: "数据洞察", icon: ChartNoAxesCombined, match: /^\/insights/ },
  { to: "/extension", label: "采集插件", icon: Puzzle, match: /^\/extension/ },
] as const;

const PAGE_TITLES: [RegExp, string][] = [
  [/^\/$/, "仪表盘"],
  [/^\/library/, "内容库"],
  [/^\/analysis/, "AI 分析"],
  [/^\/topics/, "选题池"],
  [/^\/drafts/, "草稿工坊"],
  [/^\/accounts/, "账号矩阵"],
  [/^\/publish/, "发布中心"],
  [/^\/insights/, "数据洞察"],
  [/^\/extension/, "采集插件"],
];

const ExtensionCtx = createContext<{ online: boolean | null }>({
  online: null,
});

export function useExtensionStatus() {
  return useContext(ExtensionCtx);
}

export function AppShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const online = useExtensionOnline();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const jobsQuery = useQuery({
    queryKey: ["publish-jobs"],
    queryFn: api.jobs,
    refetchInterval: 30_000,
  });

  const pageTitle =
    PAGE_TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? "工作台";

  const authorizeExtension = useCallback(async () => {
    const token = getToken();
    if (!token) {
      toast.error("请先登录");
      return;
    }
    try {
      // 插件校验 apiBase === 页面 origin，经 vite/同源代理访问 API
      await bridge.setAuth({ apiBase: window.location.origin, token });
      toast.success("插件已授权", "扩展已拿到 API 地址与登录令牌");
    } catch (err) {
      toast.error(
        "未检测到插件",
        err instanceof Error ? err.message : "请确认扩展已安装并刷新页面",
      );
    }
  }, [toast]);

  const createDraft = useCallback(async () => {
    try {
      const draft = await api.createDraft({ title: "", content: "" });
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      navigate(`/drafts/${draft.id}`);
    } catch (err) {
      toast.error("创建草稿失败", err instanceof Error ? err.message : undefined);
    }
  }, [navigate, queryClient, toast]);

  const commands = useMemo<CommandItem[]>(
    () => [
      ...NAV.map((item) => ({
        id: `nav-${item.to}`,
        label: `前往：${item.label}`,
        group: "页面",
        icon: item.icon,
        keywords: [item.label, item.to],
        onSelect: () => navigate(item.to),
      })),
      {
        id: "new-draft",
        label: "新建草稿",
        group: "操作",
        icon: Plus,
        keywords: ["draft", "草稿", "新建"],
        onSelect: () => void createDraft(),
      },
      {
        id: "new-job",
        label: "新建发布任务",
        group: "操作",
        icon: SendHorizontal,
        keywords: ["publish", "发布"],
        onSelect: () => navigate("/publish?new=1"),
      },
      {
        id: "authorize-ext",
        label: "授权浏览器插件",
        group: "操作",
        icon: Zap,
        keywords: ["extension", "插件", "授权"],
        onSelect: () => void authorizeExtension(),
      },
      {
        id: "ai-rewrite",
        label: "AI：改写当前草稿",
        group: "AI",
        icon: Sparkles,
        keywords: ["ai", "rewrite", "改写"],
        onSelect: () => navigate("/drafts"),
      },
    ],
    [navigate, createDraft, authorizeExtension],
  );

  const notificationItems = useMemo<NotificationStackItem[]>(() => {
    const jobs = (jobsQuery.data ?? [])
      .filter((j) => j.status === "failed" || j.status === "running")
      .slice(0, 6);
    return jobs.map((j) => ({
      id: String(j.id),
      title: (
        <span className="flex items-center gap-2">
          <AnimatedBadge
            size="sm"
            status={JOB_STATUS_META[j.status]?.status ?? "neutral"}
          >
            {JOB_STATUS_META[j.status]?.label ?? j.status}
          </AnimatedBadge>
          任务 #{j.id}
        </span>
      ),
      description: j.error || `草稿 #${j.draftId} · 账号 #${j.accountId}`,
    }));
  }, [jobsQuery.data]);

  const extBadge = (
    <AnimatedBadge
      size="sm"
      status={online === null ? "loading" : online ? "success" : "neutral"}
      pulse={online === true}
      title="浏览器插件连接状态（site-bridge PING）"
    >
      {online === null ? "插件检测中" : online ? "插件已连接" : "未检测到插件"}
    </AnimatedBadge>
  );

  return (
    <ExtensionCtx.Provider value={{ online }}>
      <AnimatedSidebarProvider className="h-dvh min-h-0 w-full overflow-hidden bg-background">
        <AnimatedSidebar
          ariaLabel="v2-media 工作台"
          collapsible="icon"
          className="min-h-0"
          panelClassName="border-border"
        >
          <AnimatedSidebarHeader className="p-3 pb-2">
            <div className="flex min-h-11 items-center gap-3 overflow-hidden px-2">
              <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Layers aria-hidden className="size-4" />
              </div>
              <div className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                <p className="truncate text-sm font-semibold text-foreground">
                  v2-media
                </p>
                <p className="truncate text-[10px] text-muted-foreground">
                  小红书运营工作台
                </p>
              </div>
              <AnimatedSidebarClose className="ml-auto text-muted-foreground hover:bg-muted md:hidden">
                <X aria-hidden className="size-4" />
              </AnimatedSidebarClose>
            </div>
          </AnimatedSidebarHeader>

          <AnimatedSidebarContent className="px-2 pt-1">
            <AnimatedSidebarGroup>
              <AnimatedSidebarGroupContent>
                <AnimatedSidebarMenu>
                  {NAV.map(({ to, label, icon: Icon, match }) => (
                    <AnimatedSidebarMenuItem key={to}>
                      <AnimatedSidebarMenuButton
                        isActive={match.test(location.pathname)}
                        icon={<Icon className="size-4" />}
                        onSelect={() => navigate(to)}
                      >
                        {label}
                      </AnimatedSidebarMenuButton>
                    </AnimatedSidebarMenuItem>
                  ))}
                </AnimatedSidebarMenu>
              </AnimatedSidebarGroupContent>
            </AnimatedSidebarGroup>
          </AnimatedSidebarContent>

          <AnimatedSidebarFooter className="gap-3 border-none p-3">
            <Popover side="top" align="start">
              <PopoverTrigger>
                <button
                  type="button"
                  className="flex min-h-11 w-full items-center gap-3 overflow-hidden rounded-xl p-1 text-left outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                    {(user?.email ?? "?").slice(0, 2).toUpperCase()}
                  </span>
                  <span className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {user?.email ?? "未登录"}
                    </span>
                    <span className="block truncate text-xs text-muted-foreground">
                      账号设置
                    </span>
                  </span>
                  <ChevronsUpDown
                    aria-hidden
                    className="size-4 shrink-0 text-muted-foreground group-data-[state=collapsed]/sidebar:hidden"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent className="w-52">
                <div className="flex flex-col gap-1 p-1.5">
                  <div className="px-2.5 py-2">
                    <p className="truncate text-sm font-medium text-foreground">
                      {user?.email}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ID #{user?.id}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      logout();
                      navigate("/login");
                    }}
                    className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:bg-destructive/10"
                  >
                    <LogOut className="size-4" />
                    退出登录
                  </button>
                </div>
              </PopoverContent>
            </Popover>
          </AnimatedSidebarFooter>

          <AnimatedSidebarRail />
        </AnimatedSidebar>

        <AnimatedSidebarInset className="min-h-0 bg-background">
          <header className="flex h-14 shrink-0 items-center gap-3 border-border border-b px-4">
            <AnimatedSidebarTrigger className="text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <PanelLeft aria-hidden className="size-4" />
            </AnimatedSidebarTrigger>
            <p className="text-sm font-semibold text-foreground">{pageTitle}</p>

            <div className="ml-auto flex items-center gap-2">
              {extBadge}

              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden h-8 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-muted sm:inline-flex"
              >
                <PanelLeft className="hidden" aria-hidden />
                命令面板
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
                  ⌘K
                </kbd>
              </button>

              <Popover side="bottom" align="end">
                <PopoverTrigger>
                  <button
                    type="button"
                    aria-label="通知"
                    className="relative grid size-8 place-items-center rounded-lg text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Bell className="size-4" />
                    {notificationItems.length > 0 ? (
                      <span className="absolute right-1 top-1 size-1.5 rounded-full bg-primary" />
                    ) : null}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-80 p-0">
                  <NotificationStack
                    items={notificationItems}
                    emptyLabel="暂无发布通知"
                    collapsedLabel="查看发布动态"
                    expandedLabel="收起"
                    onViewAll={() => navigate("/publish")}
                    className="p-2"
                  />
                </PopoverContent>
              </Popover>

              <ThemeToggle
                variant="circle-blur"
                className="size-8 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                iconClassName="size-4"
              />
            </div>
          </header>

          <main className="min-h-0 flex-1 overflow-y-auto">
            {import.meta.env.VITE_PREVIEW_NOTICE && <p role="status" className="border-b border-amber-500/20 bg-amber-500/10 px-6 py-2 text-xs leading-5 text-amber-700 dark:text-amber-300">{import.meta.env.VITE_PREVIEW_NOTICE}</p>}
            <Outlet />
          </main>
        </AnimatedSidebarInset>
      </AnimatedSidebarProvider>

      <CommandPalette
        items={commands}
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        placeholder="跳页面 / 执行操作…"
        emptyMessage="没有匹配的命令"
      />
    </ExtensionCtx.Provider>
  );
}
