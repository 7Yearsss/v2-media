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
import AccountsPage from "@/pages/accounts";
import DashboardPage from "@/pages/dashboard";
import DraftsPage from "@/pages/drafts";
import LibraryPage from "@/pages/library";
import LoginPage from "@/pages/login";
import PublishPage from "@/pages/publish";

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
      <Route path="/login" element={<LoginPage />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<DashboardPage />} />
        <Route path="library" element={<LibraryPage />} />
        <Route path="drafts" element={<DraftsPage />} />
        <Route path="drafts/:id" element={<DraftsPage />} />
        <Route path="accounts" element={<AccountsPage />} />
        <Route path="publish" element={<PublishPage />} />
        <Route
          path="*"
          element={
            <div className="flex h-full items-center justify-center p-8">
              <NotFoundSpotlight
                title="页面不存在"
                description="这个地址没有对应的工作台页面"
                homeHref="/"
                homeLabel="回到仪表盘"
                browseHref="/library"
                browseLabel="去内容库"
              />
            </div>
          }
        />
      </Route>
    </Routes>
  );
}
