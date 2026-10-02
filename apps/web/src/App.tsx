import type { ReactNode } from "react";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
} from "react-router-dom";
import { AppShell } from "@/components/app/app-shell";
import { NotFoundSpotlight } from "@/components/motion/not-found";
import { useAuth } from "@/lib/auth";
import { RoutePage } from "@/components/app/route-page";

const pages = {
  login: () => import("@/pages/login"),
  dashboard: () => import("@/pages/dashboard"),
  library: () => import("@/pages/library"),
  analysis: () => import("@/pages/analysis"),
  topics: () => import("@/pages/topics"),
  drafts: () => import("@/pages/drafts"),
  accounts: () => import("@/pages/accounts"),
  publish: () => import("@/pages/publish"),
  insights: () => import("@/pages/insights"),
  collectionTasks: () => import("@/pages/collection-tasks"),
  extension: () => import("@/pages/extension"),
};

function RequireAuth({ children }: { children: ReactNode }) {
  const { token } = useAuth();
  const location = useLocation();
  if (!token) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }
  return children;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<RoutePage load={pages.login} />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<RoutePage load={pages.dashboard} />} />
        <Route path="library" element={<RoutePage load={pages.library} />} />
        <Route path="analysis" element={<RoutePage load={pages.analysis} />} />
        <Route path="topics" element={<RoutePage load={pages.topics} />} />
        <Route path="drafts" element={<RoutePage load={pages.drafts} />} />
        <Route path="drafts/:id" element={<RoutePage load={pages.drafts} />} />
        <Route path="accounts" element={<RoutePage load={pages.accounts} />} />
        <Route path="publish" element={<RoutePage load={pages.publish} />} />
        <Route path="insights" element={<RoutePage load={pages.insights} />} />
        <Route path="insights/:id" element={<RoutePage load={pages.insights} />} />
        <Route path="collection-tasks" element={<RoutePage load={pages.collectionTasks} />} />
        <Route path="extension" element={<RoutePage load={pages.extension} />} />
        <Route
          path="*"
          element={
            <div className="flex h-full items-center justify-center p-8">
              <NotFoundSpotlight
                title="页面不存在"
                description="请检查地址"
                homeHref="/"
                homeLabel="回到今日"
                browseHref="/library"
                browseLabel="资料库"
              />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
