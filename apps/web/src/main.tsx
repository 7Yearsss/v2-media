import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "./index.css";
import App from "./App";
import { AuthProvider } from "@/lib/auth";
import { SessionQueryProvider } from "@/lib/session-query-provider";
import { ThemeProvider } from "@/lib/theme";
import { ToastProvider } from "@/lib/toast";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <SessionQueryProvider>
          <BrowserRouter>
            <ToastProvider>
              <App />
            </ToastProvider>
          </BrowserRouter>
        </SessionQueryProvider>
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
