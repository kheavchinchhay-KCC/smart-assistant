import { NavLink } from "react-router-dom";
import { useApp } from "../contexts/AppContext";

export default function NavTabs() {
  const { t, user } = useApp();

  return (
    <div className="nav-tabs">
      <NavLink to="/" end className={({ isActive }) => (isActive ? "active" : "")}>{t("nav.dashboard")}</NavLink>
      <NavLink to="/sale" className={({ isActive }) => (isActive ? "active" : "")}>{t("nav.sale")}</NavLink>
      <NavLink to="/petty-cash" className={({ isActive }) => (isActive ? "active" : "")}>{t("nav.pettyCash")}</NavLink>
      <NavLink to="/settings" className={({ isActive }) => (isActive ? "active" : "")}>{t("nav.settings")}</NavLink>
      {user?.role === "ADMIN" && (
        <NavLink to="/settings/users" className={({ isActive }) => (isActive ? "active" : "")}>{t("settings.users")}</NavLink>
      )}
    </div>
  );
}
