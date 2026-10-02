import { Component, lazy, Suspense, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { Button } from "@/components/motion/button";
import { PageLoading } from "./states";

type PageLoader = () => Promise<{ default: ComponentType }>;
const pageTypes = new WeakMap<PageLoader, LazyExoticComponent<ComponentType>>();

function pageType(load: PageLoader) {
  let page = pageTypes.get(load);
  if (!page) {
    page = lazy(load);
    pageTypes.set(load, page);
  }
  return page;
}

class PageBoundary extends Component<
  { children: ReactNode; onRetry: () => void; resetKey: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error("页面加载失败") };
  }

  componentDidUpdate(previous: Readonly<{ children: ReactNode; onRetry: () => void; resetKey: string }>) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const chunkError = /dynamically imported module|loading chunk|module script|importing a module|preload.*css/i.test(this.state.error.message);
    return <div role="alert" className="flex min-h-64 flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-base font-semibold">{chunkError ? "页面资源没有加载成功" : "这个页面暂时无法显示"}</h1>
      <p className="max-w-sm text-sm leading-6 text-muted-foreground">{chunkError
        ? "请检查网络后重试。若应用刚更新，刷新页面可读取新的版本。"
        : "可以重试，或从侧栏打开其它工作区。"}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" variant="outline" onClick={this.props.onRetry}>重新加载页面</Button>
        <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>刷新应用</Button>
      </div>
      <p className="text-xs text-muted-foreground">刷新应用前，请确认其它页面的内容已保存。</p>
    </div>;
  }
}

function PageAttempt({ load, pathname }: { load: PageLoader; pathname: string }) {
  const [attempt, setAttempt] = useState(0);
  // Suspended renders can discard hook memoization. Keep the lazy type outside render
  // so navigation retries observe the same pending promise instead of suspending again.
  const Page = pageType(load);
  const retry = () => {
    pageTypes.set(load, lazy(load));
    setAttempt(value => value + 1);
  };
  return <PageBoundary key={attempt} resetKey={pathname} onRetry={retry}>
    <Suspense fallback={<PageLoading label="加载工作区…" />}><Page /></Suspense>
  </PageBoundary>;
}

export function RoutePage({ load }: { load: PageLoader }) {
  const location = useLocation();
  return <PageAttempt pathname={location.pathname} load={load} />;
}
