import { useEffect, useState } from "react";
import { useApp } from "../contexts/AppContext";
import { callApi, ApiError } from "../lib/api";
import { downloadCsv, openPrintReportWindow, renderPrintReport } from "../lib/export";
import { DatePresetFilters, resolvePresetRange, ConfirmModal, dateKeyInTimezone, zonedDateTimeToIso, type DatePreset } from "../components/Shared";

interface PettyRow {
  id: string; display_id: string; transaction_at: string; type: "IN" | "OUT";
  amount: number; remark: string; running_balance: number; source: string; mode: string; total_count: number;
}

interface PettySummary {
  cash_in: number;
  expense: number;
  period_balance: number;
  current_cash: number;
}

export default function PettyCash() {
  const { t, user } = useApp();
  const today = dateKeyInTimezone(user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Phnom_Penh");
  const [preset, setPreset] = useState<DatePreset>("TODAY");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [rows, setRows] = useState<PettyRow[]>([]);
  const [summary, setSummary] = useState<PettySummary>({ cash_in: 0, expense: 0, period_balance: 0, current_cash: 0 });
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PettyRow | null>(null);
  const [editTarget, setEditTarget] = useState<PettyRow | null>(null);
  const [formType, setFormType] = useState<"IN" | "OUT" | null>(null);
  const [error, setError] = useState<string | null>(null);

  function range() {
    return resolvePresetRange(preset, { start: customStart, end: customEnd }, user?.timezone);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const { start, end } = range();
      const [data, totals] = await Promise.all([
        callApi<PettyRow[]>("petty.list", { keyword, start, end, limit: 100, offset: 0 }),
        callApi<PettySummary>("petty.summary", { start, end }),
      ]);
      setRows(data);
      setSummary(totals);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [preset]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (preset === "CUSTOM") void load(); }, [customStart, customEnd]); // eslint-disable-line react-hooks/exhaustive-deps

  async function exportRows() {
    setWorking(true);
    setError(null);
    try {
      const { start, end } = range();
      const result = await callApi<{ rows: PettyRow[]; total_count: number; truncated: boolean }>("petty.export", { keyword, start, end });
      if (result.truncated) throw new Error(t("common.exportTooLarge"));
      const headers = [t("petty.pettyId"), t("sale.date"), t("petty.type"), t("sale.amount"), t("sale.remark"), t("petty.runningBalance"), t("common.source"), t("common.mode")];
      downloadCsv(`petty-cash-${today}.csv`, headers, result.rows.map((r) => [
        r.display_id, new Date(r.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined }), r.type, r.amount, r.remark, r.running_balance, r.source, r.mode,
      ]));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : t("common.error"));
    } finally {
      setWorking(false);
    }
  }

  async function printPdf() {
    const popup = openPrintReportWindow();
    setWorking(true);
    setError(null);
    try {
      const { start, end } = range();
      const result = await callApi<{ rows: PettyRow[]; total_count: number; truncated: boolean }>("petty.export", { keyword, start, end });
      if (result.truncated) throw new Error(t("common.exportTooLarge"));
      renderPrintReport(
        popup,
        t("nav.pettyCash"),
        `${new Date(start).toLocaleString(undefined, { timeZone: user?.timezone || undefined })} → ${new Date(end).toLocaleString(undefined, { timeZone: user?.timezone || undefined })} · ${user?.display_name ?? ""}`,
        [t("petty.pettyId"), t("sale.date"), t("petty.type"), t("sale.amount"), t("sale.remark"), t("petty.runningBalance"), t("common.source"), t("common.mode")],
        result.rows.map((r) => [r.display_id, new Date(r.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined }), r.type, r.amount, r.remark, r.running_balance, r.source, r.mode]),
        [[t("petty.cashIn"), result.rows.filter((r) => r.type === "IN").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2)], [t("petty.expense"), result.rows.filter((r) => r.type === "OUT").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2)], [t("common.currentCash"), Number(summary.current_cash).toFixed(2)]],
      );
    } catch (e) {
      try { if (!popup.closed) popup.close(); } catch { /* ignore */ }
      setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : t("common.error"));
    } finally {
      setWorking(false);
    }
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    setWorking(true);
    try {
      await callApi("petty.delete", { display_id: deleteTarget.display_id });
      setDeleteTarget(null);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setWorking(false);
    }
  }

  return (
    <div>
      <DatePresetFilters
        value={preset}
        onChange={setPreset}
        customStart={customStart}
        customEnd={customEnd}
        onCustomChange={(start, end) => { setCustomStart(start); setCustomEnd(end < start ? start : end); }}
      />
      <div className="filters">
        <input placeholder={t("common.search")} value={keyword} onChange={(e) => setKeyword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} />
        <button className="btn" onClick={load} disabled={working}>{t("common.search")}</button>
        <button className="btn secondary" onClick={() => setFormType("IN")} disabled={working}>{t("petty.cashIn")}</button>
        <button className="btn secondary" onClick={() => setFormType("OUT")} disabled={working}>{t("petty.expense")}</button>
        <button className="btn secondary" onClick={exportRows} disabled={working}>{t("common.export")}</button>
        <button className="btn secondary" onClick={printPdf} disabled={working}>{t("common.printPdf")}</button>
      </div>

      <div className="summary-grid">
        <div className="summary-card"><div className="label">{t("petty.cashIn")}</div><div className="value">${Number(summary.cash_in).toFixed(2)}</div></div>
        <div className="summary-card"><div className="label">{t("petty.expense")}</div><div className="value">${Number(summary.expense).toFixed(2)}</div></div>
        <div className="summary-card"><div className="label">{t("common.balance")}</div><div className="value">${Number(summary.period_balance).toFixed(2)}</div></div>
        <div className="summary-card"><div className="label">{t("common.currentCash")}</div><div className="value">${Number(summary.current_cash).toFixed(2)}</div></div>
      </div>

      <div className="card">
        {loading ? <div className="loading-state">{t("common.loading")}</div> : (
          <table>
            <thead><tr><th>{t("petty.pettyId")}</th><th>{t("sale.date")}</th><th>{t("petty.type")}</th><th>{t("sale.amount")}</th><th>{t("petty.runningBalance")}</th><th>{t("sale.remark")}</th><th></th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{r.display_id}</td>
                  <td>{new Date(r.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined })}</td>
                  <td>{r.type}</td>
                  <td>{r.amount}</td>
                  <td>{r.running_balance}</td>
                  <td>{r.remark}</td>
                  <td>
                    <button className="btn secondary" onClick={() => setEditTarget(r)} disabled={working}>{t("common.edit")}</button>
                    <button className="btn danger" onClick={() => setDeleteTarget(r)} disabled={working} style={{ marginLeft: 6 }}>{t("common.delete")}</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={7}>{t("common.noData")}</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          title={t("petty.confirmDelete")}
          lines={[
            `${t("petty.pettyId")}: ${deleteTarget.display_id}`,
            `${t("petty.type")}: ${deleteTarget.type}`,
            `${t("sale.amount")}: ${deleteTarget.amount}`,
            `${t("sale.remark")}: ${deleteTarget.remark}`,
          ]}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editTarget && (
        <EditPettyCashModal
          row={editTarget}
          timezone={user?.timezone}
          onClose={() => setEditTarget(null)}
          onSaved={async () => { setEditTarget(null); await load(); }}
          onError={setError}
        />
      )}

      {formType && (
        <PettyCashForm
          type={formType}
          timezone={user?.timezone}
          onClose={() => setFormType(null)}
          onSaved={async () => { setFormType(null); await load(); }}
          onError={setError}
        />
      )}
      {error && <div className="error-state">{error}</div>}
    </div>
  );
}

function PettyCashForm({ type, timezone, onClose, onSaved, onError }: { type: "IN" | "OUT"; timezone?: string; onClose: () => void; onSaved: () => Promise<void> | void; onError: (e: string) => void }) {
  const { t } = useApp();
  const tz = timezone || "Asia/Phnom_Penh";
  const [form, setForm] = useState({ date: dateKeyInTimezone(tz), time: "12:00", amount: "", remark: "" });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await callApi("petty.create", {
        type,
        amount: parseFloat(form.amount),
        remark: form.remark || "-",
        transaction_at: zonedDateTimeToIso(form.date, `${form.time}:00`, tz),
        mode: "NORMAL",
      });
      await onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{type === "IN" ? t("petty.cashIn") : t("petty.expense")}</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          <input placeholder={t("sale.amount")} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input placeholder={t("sale.remark")} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn" disabled={saving || !form.amount} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}

function EditPettyCashModal({ row, timezone, onClose, onSaved, onError }: { row: PettyRow; timezone?: string; onClose: () => void; onSaved: () => Promise<void> | void; onError: (e: string) => void }) {
  const { t } = useApp();
  const tz = timezone || "Asia/Phnom_Penh";
  const initial = new Date(row.transaction_at);
  const dateFormatter = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" });
  const timeFormatter = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const [form, setForm] = useState({
    date: dateFormatter.format(initial),
    time: timeFormatter.format(initial),
    amount: String(row.amount),
    remark: row.remark,
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await callApi("petty.update", {
        display_id: row.display_id,
        amount: parseFloat(form.amount),
        remark: form.remark,
        transaction_at: zonedDateTimeToIso(form.date, `${form.time}:00`, tz),
      });
      await onSaved();
    } catch (e) {
      onError(e instanceof ApiError ? e.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{t("common.edit")}</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <div>{t("petty.pettyId")}: {row.display_id}</div>
          <div>{t("petty.type")}: {row.type}</div>
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          <input placeholder={t("sale.amount")} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <input placeholder={t("sale.remark")} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn" disabled={saving || !form.amount} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}
