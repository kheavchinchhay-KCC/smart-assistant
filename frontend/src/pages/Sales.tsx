import { useEffect, useState } from "react";
import { useApp } from "../contexts/AppContext";
import { callApi, ApiError } from "../lib/api";
import { downloadCsv, openPrintReportWindow, renderPrintReport } from "../lib/export";
import { DatePresetFilters, resolvePresetRange, ConfirmModal, dateKeyInTimezone, zonedDateTimeToIso, type DatePreset } from "../components/Shared";

interface SaleRow {
  id: string; transaction_at: string; customer_name: string; amount: number;
  currency: string; merchant: string; remark: string; trx_id: string; source: string; total_count: number;
}

interface SaleSummary {
  transaction_count: number;
  usd_total: number;
  khr_total: number;
}

export default function Sales() {
  const { t, user } = useApp();
  const today = dateKeyInTimezone(user?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Phnom_Penh");
  const [preset, setPreset] = useState<DatePreset>("TODAY");
  const [customStart, setCustomStart] = useState(today);
  const [customEnd, setCustomEnd] = useState(today);
  const [rows, setRows] = useState<SaleRow[]>([]);
  const [summary, setSummary] = useState<SaleSummary>({ transaction_count: 0, usd_total: 0, khr_total: 0 });
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SaleRow | null>(null);
  const [editTarget, setEditTarget] = useState<SaleRow | null>(null);
  const [showAdd, setShowAdd] = useState(false);
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
        callApi<SaleRow[]>("sales.list", { keyword, start, end, limit: 100, offset: 0 }),
        callApi<SaleSummary>("sales.summary", { start, end }),
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
      const result = await callApi<{ rows: SaleRow[]; total_count: number; truncated: boolean }>("sales.export", { keyword, start, end });
      if (result.truncated) throw new Error(t("common.exportTooLarge"));
      const headers = [t("sale.date"), t("sale.customer"), t("sale.amount"), t("sale.currency"), t("sale.merchant"), t("sale.remark"), t("sale.trxId"), t("sale.source")];
      downloadCsv(`sales-${today}.csv`, headers, result.rows.map((r) => [
        new Date(r.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined }), r.customer_name, r.amount, r.currency, r.merchant, r.remark, r.trx_id, r.source,
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
      const result = await callApi<{ rows: SaleRow[]; total_count: number; truncated: boolean }>("sales.export", { keyword, start, end });
      if (result.truncated) throw new Error(t("common.exportTooLarge"));
      renderPrintReport(
        popup,
        t("nav.sale"),
        `${new Date(start).toLocaleString(undefined, { timeZone: user?.timezone || undefined })} → ${new Date(end).toLocaleString(undefined, { timeZone: user?.timezone || undefined })} · ${user?.display_name ?? ""}`,
        [t("sale.date"), t("sale.customer"), t("sale.amount"), t("sale.currency"), t("sale.merchant"), t("sale.remark"), t("sale.trxId"), t("sale.source")],
        result.rows.map((r) => [new Date(r.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined }), r.customer_name, r.amount, r.currency, r.merchant, r.remark, r.trx_id, r.source]),
        [["USD", result.rows.filter((r) => r.currency === "USD").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(2)], ["KHR", result.rows.filter((r) => r.currency === "KHR").reduce((sum, r) => sum + Number(r.amount), 0).toFixed(0)]],
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
      await callApi("sales.delete", { id: deleteTarget.id });
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
        <button className="btn secondary" onClick={() => setShowAdd(true)} disabled={working}>{t("sale.addMissing")}</button>
        <button className="btn secondary" onClick={exportRows} disabled={working}>{t("common.export")}</button>
        <button className="btn secondary" onClick={printPdf} disabled={working}>{t("common.printPdf")}</button>
      </div>

      <div className="summary-grid">
        <div className="summary-card"><div className="label">{t("common.count")}</div><div className="value">{summary.transaction_count}</div></div>
        <div className="summary-card"><div className="label">USD</div><div className="value">${Number(summary.usd_total).toFixed(2)}</div></div>
        <div className="summary-card"><div className="label">KHR</div><div className="value">៛{Number(summary.khr_total).toFixed(0)}</div></div>
      </div>

      <div className="card">
        {loading ? <div className="loading-state">{t("common.loading")}</div> : (
          <table>
            <thead>
              <tr>
                <th>{t("sale.date")}</th><th>{t("sale.customer")}</th><th>{t("sale.amount")}</th>
                <th>{t("sale.merchant")}</th><th>{t("sale.trxId")}</th><th></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td>{new Date(r.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined })}</td>
                  <td>{r.customer_name}</td>
                  <td>{r.currency} {r.amount}</td>
                  <td>{r.merchant}</td>
                  <td>{r.trx_id}</td>
                  <td>
                    <button className="btn secondary" onClick={() => setEditTarget(r)} disabled={working}>{t("common.edit")}</button>
                    <button className="btn danger" onClick={() => setDeleteTarget(r)} disabled={working} style={{ marginLeft: 6 }}>{t("common.delete")}</button>
                  </td>
                </tr>
              ))}
              {rows.length === 0 && <tr><td colSpan={6}>{t("common.noData")}</td></tr>}
            </tbody>
          </table>
        )}
      </div>

      {deleteTarget && (
        <ConfirmModal
          title={t("sale.confirmDelete")}
          lines={[
            `${t("sale.date")}: ${new Date(deleteTarget.transaction_at).toLocaleString(undefined, { timeZone: user?.timezone || undefined })}`,
            `${t("sale.customer")}: ${deleteTarget.customer_name}`,
            `${t("sale.amount")}: ${deleteTarget.currency} ${deleteTarget.amount}`,
            `${t("sale.merchant")}: ${deleteTarget.merchant}`,
            `${t("sale.trxId")}: ${deleteTarget.trx_id}`,
          ]}
          onConfirm={confirmDelete}
          onCancel={() => setDeleteTarget(null)}
        />
      )}

      {editTarget && (
        <EditSaleModal
          row={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={async () => { setEditTarget(null); await load(); }}
          onError={setError}
        />
      )}

      {showAdd && (
        <AddMissingSaleModal
          timezone={user?.timezone}
          onClose={() => setShowAdd(false)}
          onSaved={async () => { setShowAdd(false); await load(); }}
          onError={setError}
        />
      )}
      {error && <div className="error-state">{error}</div>}
    </div>
  );
}

function AddMissingSaleModal({
  timezone, onClose, onSaved, onError,
}: { timezone?: string; onClose: () => void; onSaved: () => Promise<void> | void; onError: (e: string) => void }) {
  const { t } = useApp();
  const tz = timezone || "Asia/Phnom_Penh";
  const [form, setForm] = useState({
    date: dateKeyInTimezone(tz), time: "12:00", customer_name: "", amount: "",
    currency: "USD", merchant: "", remark: "", trx_id: "",
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await callApi("sales.create", {
        transaction_at: zonedDateTimeToIso(form.date, `${form.time}:00`, tz),
        customer_name: form.customer_name || "-",
        amount: parseFloat(form.amount),
        currency: form.currency,
        merchant: form.merchant,
        remark: form.remark,
        trx_id: form.trx_id,
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
        <h3>{t("sale.addMissing")}</h3>
        <div style={{ display: "grid", gap: 8 }}>
          <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
          <input type="time" value={form.time} onChange={(e) => setForm({ ...form, time: e.target.value })} />
          <input placeholder={t("sale.customer")} value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
          <input placeholder={t("sale.amount")} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD</option>
            <option value="KHR">KHR</option>
          </select>
          <input placeholder={t("sale.merchant")} value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
          <input placeholder={t("sale.remark")} value={form.remark} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
          <input placeholder={t("sale.trxId")} value={form.trx_id} onChange={(e) => setForm({ ...form, trx_id: e.target.value })} />
        </div>
        <div className="actions">
          <button className="btn secondary" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn" disabled={saving || !form.amount || !form.trx_id} onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    </div>
  );
}

function EditSaleModal({
  row, onClose, onSaved, onError,
}: { row: SaleRow; onClose: () => void; onSaved: () => Promise<void> | void; onError: (e: string) => void }) {
  const { t } = useApp();
  const [form, setForm] = useState({
    customer_name: row.customer_name, amount: String(row.amount), currency: row.currency,
    merchant: row.merchant, remark: row.remark,
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await callApi("sales.update", { id: row.id, ...form, amount: parseFloat(form.amount) });
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
          <div>{t("sale.date")}: {new Date(row.transaction_at).toLocaleString(undefined, { timeZone: timezone || undefined })}</div>
          <div>{t("sale.trxId")}: {row.trx_id}</div>
          <input placeholder={t("sale.customer")} value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} />
          <input placeholder={t("sale.amount")} type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
          <select value={form.currency} onChange={(e) => setForm({ ...form, currency: e.target.value })}>
            <option value="USD">USD</option><option value="KHR">KHR</option>
          </select>
          <input placeholder={t("sale.merchant")} value={form.merchant} onChange={(e) => setForm({ ...form, merchant: e.target.value })} />
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
