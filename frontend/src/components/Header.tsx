import { useApp } from "../contexts/AppContext";

export default function Header() {
  const { user, lang, setLang, theme, toggleTheme, t } = useApp();

  return (
    <div className="header">
      <div className="brand">Smart Assistant</div>
      <div className="actions">
        {user && (
          <span className="validity">
            {user.display_name} —{" "}
            {user.expires_at ? t("header.validUntil", { date: user.expires_at }) : t("header.validForever")}
          </span>
        )}
        <button onClick={() => setLang(lang === "en" ? "kh" : "en")}>{lang === "en" ? "🇰🇭 KH" : "🇬🇧 EN"}</button>
        <button onClick={toggleTheme}>{theme === "day" ? "🌙" : "☀️"}</button>
      </div>
    </div>
  );
}
