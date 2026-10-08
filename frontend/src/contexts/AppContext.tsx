// frontend/src/contexts/AppContext.tsx
// Bootstraps the Telegram Mini App session (spec §16 steps 1-10),
// and owns language + theme, both persisted so a refresh never resets
// them (spec §22).

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { authenticateWithTelegram, getStoredSession, callApi, type SessionUser } from "../lib/api";
import { completeTelegramWebLogin } from "../lib/webAuth";
import { translate, type Lang } from "../i18n";

type Theme = "day" | "night";
type AuthStatus = "checking" | "authenticated" | "denied" | "login_required";

interface AppContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  lang: Lang;
  setLang: (lang: Lang) => void;
  theme: Theme;
  toggleTheme: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  authError: string | null;
}

const AppContext = createContext<AppContextValue | null>(null);

// deno-lint-ignore no-explicit-any
declare const window: any;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [lang, setLangState] = useState<Lang>((localStorage.getItem("lang") as Lang) || "en");
  const [theme, setTheme] = useState<Theme>((localStorage.getItem("theme") as Theme) || "day");
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.setAttribute("lang", lang);
    localStorage.setItem("lang", lang);
  }, [lang]);

  useEffect(() => {
    async function bootstrap() {
      setAuthError(null);

      if (window.location.pathname === "/auth/callback") {
        try {
          const session = await completeTelegramWebLogin(window.location.search);
          setUser(session.user);
          setLangState(session.user.language);
          window.history.replaceState({}, document.title, "/");
          setStatus("authenticated");
        } catch (e) {
          setAuthError(e instanceof Error ? e.message : "Telegram web login failed");
          setStatus("denied");
        }
        return;
      }

      const existing = getStoredSession();
      if (existing) {
        setUser(existing.user);
        setLangState(existing.user.language);
        setStatus("authenticated");
        return;
      }

      const tg = window.Telegram?.WebApp;
      if (tg?.initData) {
        tg.ready?.();
        tg.expand?.();
        try {
          const session = await authenticateWithTelegram(tg.initData);
          setUser(session.user);
          setLangState(session.user.language);
          setStatus("authenticated");
        } catch {
          setStatus("denied");
        }
        return;
      }

      setStatus("login_required");
    }
    bootstrap();
  }, []);

  const setLang = (newLang: Lang) => {
    setLangState(newLang);
    if (user) {
      callApi("profile.updateLanguage", { language: newLang }).catch(() => {
        // Non-fatal: local UI already switched; server sync retried next call.
      });
    }
  };

  const toggleTheme = () => setTheme((t) => (t === "day" ? "night" : "day"));

  const value = useMemo<AppContextValue>(
    () => ({ status, user, lang, setLang, theme, toggleTheme, authError, t: (k, v) => translate(lang, k, v) }),
    [status, user, lang, theme, authError],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
