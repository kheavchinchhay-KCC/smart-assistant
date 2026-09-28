// frontend/src/contexts/AppContext.tsx
// Bootstraps the Telegram Mini App session (spec §16 steps 1-10),
// and owns language + theme, both persisted so a refresh never resets
// them (spec §22).

import React, { createContext, useContext, useEffect, useMemo, useState } from "react";
import { authenticateWithTelegram, getStoredSession, callApi, type SessionUser } from "../lib/api";
import { translate, type Lang } from "../i18n";

type Theme = "day" | "night";
type AuthStatus = "checking" | "authenticated" | "denied" | "not_in_telegram";

interface AppContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  lang: Lang;
  setLang: (lang: Lang) => void;
  theme: Theme;
  toggleTheme: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}

const AppContext = createContext<AppContextValue | null>(null);

// deno-lint-ignore no-explicit-any
declare const window: any;

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>("checking");
  const [user, setUser] = useState<SessionUser | null>(null);
  const [lang, setLangState] = useState<Lang>((localStorage.getItem("lang") as Lang) || "en");
  const [theme, setTheme] = useState<Theme>((localStorage.getItem("theme") as Theme) || "day");

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
      const existing = getStoredSession();
      if (existing) {
        setUser(existing.user);
        setLangState(existing.user.language);
        setStatus("authenticated");
        return;
      }

      const tg = window.Telegram?.WebApp;
      if (!tg || !tg.initData) {
        setStatus("not_in_telegram");
        return;
      }

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
    () => ({ status, user, lang, setLang, theme, toggleTheme, t: (k, v) => translate(lang, k, v) }),
    [status, user, lang, theme],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp must be used within AppProvider");
  return ctx;
}
