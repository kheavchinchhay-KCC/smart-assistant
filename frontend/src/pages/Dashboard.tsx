import { useEffect, useState } from "react";
import { useApp } from "../contexts/AppContext";
import { callApi } from "../lib/api";
import { SummaryCard } from "../components/Shared";

interface DashboardSummary {
  today: { transaction_count: number; usd_total: number; khr_total: number };
  week: { transaction_count: number; usd_total: number; khr_total: number };
  month: { transaction_count: number; usd_total: number; khr_total: number };
  petty_today: { cash_in: number; expense: number };
  current_cash: number;
  low_cash_threshold: number;
  latest_sales: Array<{ id: string; transaction_at: string; customer_name: string; amount: number; currency: string; merchant: string; trx_id: string }>;
  latest_petty: Array<{ id: string; display_id: string; transaction_at: string; type: string; amount: number; remark: string }>;
}

export default function Dashboard() {
  const { t } = useApp();
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<Record<string, unknown>>>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    callApi<DashboardSummary>("dashboard.summary").then(setData).finally(() => setLoading(false));
  }, []);

  async function runSearch(q: string) {
    setQuery(q);
    if (!q.trim()) { setResults([]); return; }
    const rows = await callApi<Array<Record<string, unknown>>>("dashboard.search", { keyword: q });
    setResults(rows);
  }

  if (loading) return <div className="loading-state">{t("common.loading")}</div>;
  if (!data) return <div className="error-state">{t("common.error")}</div>;

  const lowCash = data.current_cash < data.low_cash_threshold;

  return (
    <div>
      <div className="card">
        <input
          placeholder={t("common.search")}
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          style={{ width: "100%" }}
        />
        {results.length > 0 && (
          <table style={{ marginTop: 8 }}>
            <tbody>
              {results.map((r, i) => (
                <tr key={i}>
                  <td>{String(r.kind)}</td>
                  <td>{String(r.label)}</td>
                  <td>{String(r.amount)} {String(r.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="summary-grid">
        <SummaryCard label={t("dashboard.todaySales")} value={`$${data.today.usd_total.toFixed(2)}`} />
        <SummaryCard label={t("dashboard.currentCash")} value={`$${data.current_cash.toFixed(2)}`} warning={lowCash} />
        <SummaryCard label={t("dashboard.todayCashIn")} value={`$${data.petty_today.cash_in.toFixed(2)}`} />
        <SummaryCard label={t("dashboard.todayExpense")} value={`$${data.petty_today.expense.toFixed(2)}`} />
      </div>
      {lowCash && <div className="summary-card warning" style={{ marginBottom: 16 }}>{t("dashboard.lowCashWarning")}</div>}

      <div className="card">
        <h3>{t("dashboard.latestActivity")}</h3>
        <table>
          <thead>
            <tr><th>{t("sale.date")}</th><th>{t("sale.customer")}</th><th>{t("sale.amount")}</th><th>{t("sale.merchant")}</th></tr>
          </thead>
          <tbody>
            {data.latest_sales.map((s) => (
              <tr key={s.id}>
                <td>{new Date(s.transaction_at).toLocaleString()}</td>
                <td>{s.customer_name}</td>
                <td>{s.currency} {s.amount}</td>
                <td>{s.merchant}</td>
              </tr>
            ))}
            {data.latest_sales.length === 0 && <tr><td colSpan={4}>{t("common.noData")}</td></tr>}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3>{t("nav.pettyCash")}</h3>
        <table>
          <thead>
            <tr><th>{t("petty.pettyId")}</th><th>{t("sale.date")}</th><th>{t("petty.type")}</th><th>{t("sale.amount")}</th><th>{t("sale.remark")}</th></tr>
          </thead>
          <tbody>
            {data.latest_petty.map((p) => (
              <tr key={p.id}>
                <td>{p.display_id}</td>
                <td>{new Date(p.transaction_at).toLocaleString()}</td>
                <td>{p.type}</td>
                <td>{p.amount}</td>
                <td>{p.remark}</td>
              </tr>
            ))}
            {data.latest_petty.length === 0 && <tr><td colSpan={5}>{t("common.noData")}</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
