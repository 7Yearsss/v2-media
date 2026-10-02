import {
  ListTodo,
  ChartNoAxesCombined,
  SearchCheck,
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
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import {
  AnimatedSidebar,
  AnimatedSidebarContent,
  AnimatedSidebarFooter,
  AnimatedSidebarGroup,
  AnimatedSidebarGroupContent,
  AnimatedSidebarGroupLabel,
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
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/motion/popover";
import { ThemeToggle } from "@/components/motion/theme-toggle";
import { api, getToken, captureSession, isCurrentSession } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { bridge, useExtensionOnline } from "@/lib/bridge";
import { useToast } from "@/lib/toast";
import { useRuntime } from "@/lib/hooks/use-runtime";
import { WorkspaceAccountProvider, WorkspaceAccountSelector, useWorkspaceAccount } from "@/lib/account-context";
import { TaskCenter } from "@/components/app/task-center";

const NAV = [
  { to: "/", label: "今日", icon: LayoutDashboard, match: /^\/$/ },
  { to: "/library", label: "资料库", icon: LibraryBig, match: /^\/library/ },
  { to: "/analysis", label: "AI 分析", icon: BrainCircuit, match: /^\/analysis/ },
  { to: "/topics", label: "选题", icon: Lightbulb, match: /^\/topics/ },
  { to: "/drafts", label: "草稿", icon: NotebookPen, match: /^\/drafts/ },
  { to: "/accounts", label: "账号", icon: Users, match: /^\/accounts/ },
  { to: "/publish", label: "发布", icon: SendHorizontal, match: /^\/publish/ },
  { to: "/insights", label: "复盘", icon: ChartNoAxesCombined, match: /^\/insights/ },
  { to: "/collection-tasks", label: "自动采集", icon: SearchCheck, match: /^\/collection-tasks/ },
  { to: "/extension", label: "插件", icon: Puzzle, match: /^\/extension/ },
] as const;

const WORKSPACES = [
  { to: "/", label: "今日", icon: LayoutDashboard, match: /^\/$/, pages: ["/"] },
  { to: "/library", label: "资料", icon: LibraryBig, match: /^\/(library|analysis|collection-tasks)(\/|$)/, pages: ["/library", "/analysis", "/collection-tasks"] },
  { to: "/drafts", label: "创作", icon: NotebookPen, match: /^\/(drafts|topics)(\/|$)/, pages: ["/drafts", "/topics"] },
  { to: "/publish", label: "发布", icon: SendHorizontal, match: /^\/publish(\/|$)/, pages: ["/publish"] },
  { to: "/insights", label: "复盘", icon: ChartNoAxesCombined, match: /^\/insights(\/|$)/, pages: ["/insights"] },
];

const PAGE_TITLES: [RegExp, string][] = [
  [/^\/$/, "今日"],
  [/^\/library/, "资料库"],
  [/^\/analysis/, "AI 分析"],
  [/^\/topics/, "选题"],
  [/^\/drafts/, "草稿"],
  [/^\/accounts/, "账号"],
  [/^\/publish/, "发布"],
  [/^\/insights/, "复盘"],
  [/^\/collection-tasks/, "自动采集"],
  [/^\/extension/, "插件"],
];

const ExtensionCtx = createContext<{ online: boolean | null }>({
  online: null,
});

export function useExtensionStatus() {
  return useContext(ExtensionCtx);
}

export function AppShell() {
  return <WorkspaceAccountProvider><WorkspaceShell /></WorkspaceAccountProvider>;
}

function WorkspaceShell() {
  const { readOnly } = useRuntime();
  const workspaceAccount = useWorkspaceAccount();
  const navigate = useNavigate();
  const location = useLocation();
  const currentRoute = useRef(location.pathname + location.search);
  currentRoute.current = location.pathname + location.search;
  const creation = useRef(0);
  const { user, logout } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const online = useExtensionOnline();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [tasksOpen, setTasksOpen] = useState(false);
  const workspace = WORKSPACES.find(item => item.match.test(location.pathname));
  const multiplePages = !!workspace && workspace.pages.length > 1;
  const previewNotice = import.meta.env.VITE_PREVIEW_NOTICE;

  const pageTitle =
    PAGE_TITLES.find(([re]) => re.test(location.pathname))?.[1] ?? "工作台";

  const authorizeExtension = useCallback(async () => {
    if (readOnly) { toast.info("当前为只读连接，不能授权执行插件"); return; }
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
  }, [toast, readOnly]);

  const createDraft = useCallback(async () => {
    if (readOnly) { toast.info("当前为只读连接"); return; }
    if (!workspaceAccount.canCreate) { toast.info("请先确认有效的写作账号或选择通用风格"); return; }
    const startedRoute = currentRoute.current, operation = ++creation.current, session = captureSession();
    try {
      const draft = await api.createDraft({ title: "", content: "", accountId: workspaceAccount.accountId ?? undefined });
      if (!isCurrentSession(session)) return;
      void queryClient.invalidateQueries({ queryKey: ["drafts"] });
      if (operation === creation.current && currentRoute.current === startedRoute) navigate(`/drafts/${draft.id}`);
    } catch (err) {
      if (isCurrentSession(session) && operation === creation.current && currentRoute.current === startedRoute) toast.error("创建草稿失败", err instanceof Error ? err.message : undefined);
    }
  }, [navigate, queryClient, toast, readOnly, workspaceAccount.canCreate, workspaceAccount.accountId]);

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
    ].filter(item => !readOnly || item.group === "页面"),
    [navigate, createDraft, authorizeExtension, readOnly],
  );

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
      <AnimatedSidebarProvider style={{ "--sidebar-width": "232px", "--sidebar-width-icon": "60px" }} className="workspace-shell h-dvh min-h-0 w-full overflow-hidden bg-background">
        <AnimatedSidebar
          ariaLabel="v2-media 工作台"
          collapsible="icon"
          variant="inset"
          className="workspace-sidebar min-h-0"
          panelClassName="w-[calc(100%_-_16px)] rounded-3xl border border-border bg-[var(--workspace-rail)]"
        >
          <AnimatedSidebarHeader className="p-3 pb-4">
            <div className="flex min-h-11 items-center gap-3 overflow-hidden px-2">
              <div className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                <Layers aria-hidden className="size-4" />
              </div>
              <div className="min-w-0 flex-1 group-data-[state=collapsed]/sidebar:hidden">
                <p className="truncate text-sm font-semibold text-foreground">
                  v2-media
                </p>
              </div>
              <AnimatedSidebarClose className="ml-auto text-muted-foreground hover:bg-muted md:hidden">
                <X aria-hidden className="size-4" />
              </AnimatedSidebarClose>
            </div>
          </AnimatedSidebarHeader>

          <AnimatedSidebarContent className="px-2 pt-1">
            {[
              { label: "工作区", items: WORKSPACES },
              { label: "管理", items: NAV.filter(item => ["/accounts", "/extension"].includes(item.to)) },
            ].map(group => <AnimatedSidebarGroup key={group.label} className="p-0">
              <AnimatedSidebarGroupLabel className="h-7 px-3 text-[11px] font-normal">{group.label}</AnimatedSidebarGroupLabel>
              <AnimatedSidebarGroupContent>
                <AnimatedSidebarMenu>
                  {group.items.map(({ to, label, icon: Icon, match }) => (
                    <AnimatedSidebarMenuItem key={to}>
                      <AnimatedSidebarMenuButton
                        className="workspace-nav-item"
                        isActive={match.test(location.pathname)}
                        icon={<Icon className="size-4" />}
                        onSelect={() => { if (!match.test(location.pathname)) navigate(to); }}
                      >
                        {label}
                      </AnimatedSidebarMenuButton>
                    </AnimatedSidebarMenuItem>
                  ))}
                </AnimatedSidebarMenu>
              </AnimatedSidebarGroupContent>
            </AnimatedSidebarGroup>)}
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

        <AnimatedSidebarInset className="workspace-content min-h-0 bg-background">
          <header className="workspace-chrome flex h-14 shrink-0 items-center gap-3 border-border border-b px-5">
            <AnimatedSidebarTrigger className="text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
              <PanelLeft aria-hidden className="size-4" />
            </AnimatedSidebarTrigger>
            <p className="text-sm font-semibold text-foreground">{pageTitle}</p>
            {readOnly && <span role="status" title="只读连接，修改与后台任务已停用" className="rounded-md bg-amber-500/10 px-2 py-1 text-[10px] text-amber-700 dark:text-amber-300">只读</span>}
            {previewNotice && <span role="status" title={previewNotice} className="rounded-md bg-muted px-2 py-1 text-[10px] text-muted-foreground">{previewNotice.includes("合成") ? "本地预览" : previewNotice}</span>}

            <div className="ml-auto flex items-center gap-2">
              <WorkspaceAccountSelector label="默认账号" showDetails={false} className="hidden max-w-64 lg:block" />
              <span className="hidden xl:inline-flex">{extBadge}</span>

              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                className="hidden h-8 items-center gap-2 rounded-lg border border-border bg-card px-3 text-xs text-muted-foreground transition-colors hover:bg-muted xl:inline-flex"
              >
                <PanelLeft className="hidden" aria-hidden />
                搜索
                <kbd className="rounded border border-border bg-muted px-1 font-mono text-[10px]">
                  ⌘K
                </kbd>
              </button>

              <button type="button" aria-label="任务中心" onClick={() => setTasksOpen(true)} className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-xs text-muted-foreground hover:bg-muted focus-visible:outline focus-visible:outline-ring"><ListTodo className="size-4" /><span className="hidden sm:inline">任务</span></button>

              <ThemeToggle
                variant="circle-blur"
                className="size-8 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                iconClassName="size-4"
              />
            </div>
          </header>

          <div className={`${multiplePages ? "flex" : "flex lg:hidden"} shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border bg-card px-5 py-2`}>
            {multiplePages && <nav aria-label="当前工作区" className="flex flex-wrap gap-1">
              {NAV.filter(item => workspace?.pages.includes(item.to)).map(item => <button key={item.to} type="button" onClick={() => { if (!item.match.test(location.pathname)) navigate(item.to); }} aria-current={item.match.test(location.pathname) ? "page" : undefined} className={`rounded-md px-2.5 py-1.5 text-xs transition-colors ${item.match.test(location.pathname) ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/60"}`}>{item.label}</button>)}
            </nav>}
            <WorkspaceAccountSelector label="默认账号" showDetails={false} className="ml-auto max-w-full lg:hidden" />
          </div>

          <main className="min-h-0 flex-1 overflow-y-auto">
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
      <TaskCenter open={tasksOpen} onOpenChange={setTasksOpen} />
    </ExtensionCtx.Provider>
  );
}
