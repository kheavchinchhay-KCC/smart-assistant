import { Routes, Route, Navigate } from "react-router-dom";
import { useApp } from "./contexts/AppContext";
import Header from "./components/Header";
import NavTabs from "./components/NavTabs";
import Dashboard from "./pages/Dashboard";
import Sales from "./pages/Sales";
import PettyCash from "./pages/PettyCash";
import Preferences from "./pages/Settings/Preferences";
import Users from "./pages/Settings/Users";

export default function App() {
  const { status, t } = useApp();

  if (status === "checking") {
    return <div className="loading-state">{t("auth.checking")}</div>;
  }

  if (status === "not_in_telegram") {
    return <div className="empty-state">{t("auth.openInTelegram")}</div>;
  }

  if (status === "denied") {
    return <div className="error-state">{t("auth.denied")}</div>;
  }

  return (
    <div className="app-shell">
      <Header />
      <NavTabs />
      <div className="page">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/sale" element={<Sales />} />
          <Route path="/petty-cash" element={<PettyCash />} />
          <Route path="/settings" element={<Preferences />} />
          <Route path="/settings/users" element={<Users />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </div>
  );
}
