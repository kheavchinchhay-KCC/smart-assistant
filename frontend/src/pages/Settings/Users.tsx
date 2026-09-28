import { useEffect, useState } from "react";
import { useApp } from "../../contexts/AppContext";
import { callApi, ApiError } from "../../lib/api";

interface AppUser {
  id: string; telegram_id: number; display_name: string; role: "ADMIN" | "USER"; status: string;
  starts_at: string; expires_at: string | null; last_login_at: string | null; language: string;
}

const USAGE_PERIODS = ["1_MONTH", "2_MONTHS", "3_MONTHS", "4_MONTHS", "5_MONTHS", "6_MONTHS", "1_YEAR", "FOREVER", "CUSTOM"];

export default function Users() {
  const { t, user } = useApp();
  const [users, setUsers] = useState<AppUser[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    const data = await callApi<AppUser[]>("admin.listUsers");
    setUsers(data);
  }

  useEffect(() => { load(); }, []);

  async function toggleStatus(u: AppUser) {
    const newStatus = u.status === "ACTIVE" ? "INACTIVE" : "ACTIVE";
    await callApi("admin.setValidity", { target_user_id: u.id, status: newStatus });
    load();
  }

  if (user?.role !== "ADMIN") {
    return <div className="error-state">{t("common.error")}</div>;
  }

  return (
    <div>
      <div className="filters">
        <button className="btn" onClick={() => setShowAdd(true)}>{t("settings.addUser")}</button>
      </div>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th>{t("settings.telegramId")}</th><th>{t("settings.displayName")}</th><th>{t("settings.role")}</th>
              <th>{t("settings.status")}</th><th>{t("settings.expiryDate")}</th><th>{t("settings.lastLogin")}</th><th></th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.telegram_id}</td>
                <td>{u.display_name}</td>
                <td>{u.role}</td>
                <td>{u.status}</td>
                <td>{u.expires_at ?? "Forever"}</td>
                <td>{u.last_login_at ? new Date(u.last_login_at).toLocaleString() : "-"}</td>
                <td><button className="btn secondary" onClick={() => toggleStatus(u)}>{u.status === "ACTIVE" ? "Deactivate" : "Activate"}</button></td>
              </tr>
            ))}
            {users.length === 0 && <tr><td colSpan={7}>{t("common.noData")}</td></tr>}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <AddUserModal onClose={() => setShowAdd(false)} onSaved={() => { setShowAdd(false); load(); }} onError={setError} />
      )}
      {error && <div className="error-state">{error}</div>}
    </div>
  );
}

function AddUserModal({ onClose, onSaved, onError }: { onClose: () => void; onSaved: () => void; onError: (e: string) => void }) {
  const { t } = useApp();
  const [form, setForm] = useState({
    telegram_id: "", display_name: "", role: "USER", start_date: new Date().toISOString().slice(0, 10),
    usage_period: "FOREVER", custom_expiry: "", language: "en",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await callApi("admin.createUser", {
        telegram_id: parseInt(form.telegram_id, 10),
        display_name: form.display_name,
        role: form.role,
        start_date: form.start_date,
        usage_period: form.usage_period,
        custom_expiry: form.usage_period === "CUSTOM" ? form.custom_expiry : null,
        language: form.language,
      });
      onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Failed to create user");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("settings.addUser")}</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input placeholder={t("settings.telegramId")} value={form.telegram_id} onChange={(e) => setForm({ ...form, telegram_id: e.target.value })} />
          <input placeholder={t("settings.displayName")} value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} />
          <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="USER">USER</option>
            <option value="ADMIN">ADMIN</option>
          </select>
          <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} />
          <select value={form.usage_period} onChange={(e) => setForm({ ...form, usage_period: e.target.value })}>
            {USAGE_PERIODS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          {form.usage_period === "CUSTOM" && (
            <input type="date" value={form.custom_expiry} onChange={(e) => setForm({ ...form, custom_expiry: e.target.value })} />
          )}
          <select value={form.language} onChange={(e) => setForm({ ...form, language: e.target.value })}>
            <option value="en">English</option>
            <option value="kh">Khmer</option>
          </select>
        </div>
        <div className="actions">
          <button className="btn secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn" disabled={saving} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}
