import { useState } from "react";
import { useApp } from "../contexts/AppContext";
import { startTelegramWebLogin } from "../lib/webAuth";

export default function WebLogin() {
  const { t } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const login = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await startTelegramWebLogin();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : "Unable to start Telegram login");
    }
  };

  return (
    <div className="empty-state">
      <h2>{t("auth.webLoginTitle")}</h2>
      <p>{t("auth.webLoginDescription")}</p>
      <button className="btn" onClick={login} disabled={busy}>
        {busy ? t("auth.checking") : t("auth.loginWithTelegram")}
      </button>
      {error && <p className="error-state">{error}</p>}
    </div>
  );
}
