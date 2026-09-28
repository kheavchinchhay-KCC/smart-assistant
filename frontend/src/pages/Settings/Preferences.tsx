import { useEffect, useState } from "react";
import { useApp } from "../../contexts/AppContext";
import { callApi, ApiError } from "../../lib/api";

interface Prefs {
  shop_name_1: string; shop_name_2: string; shop_name_3: string;
  expense_holder_1: string; expense_holder_2: string; expense_holder_3: string;
  khr_per_usd: number; low_cash_alert_threshold: number; selected_gemini_model: string | null;
}

interface GeminiKey {
  id: string; label: string; masked_last4: string; enabled: boolean; priority: number;
  last_tested_at: string | null; last_test_ok: boolean | null; last_error: string | null;
}

export default function Preferences() {
  const { t } = useApp();
  const [prefs, setPrefs] = useState<Prefs | null>(null);
  const [keys, setKeys] = useState<GeminiKey[]>([]);
  const [newKeyLabel, setNewKeyLabel] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [savingPrefs, setSavingPrefs] = useState(false);
  const [workingKeyId, setWorkingKeyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      const [p, k] = await Promise.all([
        callApi<Prefs>("preferences.get"),
        callApi<GeminiKey[]>("gemini.listKeys"),
      ]);
      setPrefs(p);
      setKeys(k);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  useEffect(() => { load(); }, []);

  async function savePrefs() {
    if (!prefs) return;
    setSavingPrefs(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await callApi<Prefs>("preferences.update", {
        shop_name_1: prefs.shop_name_1,
        shop_name_2: prefs.shop_name_2,
        shop_name_3: prefs.shop_name_3,
        expense_holder_1: prefs.expense_holder_1,
        expense_holder_2: prefs.expense_holder_2,
        expense_holder_3: prefs.expense_holder_3,
        khr_per_usd: Number(prefs.khr_per_usd),
        low_cash_alert_threshold: Number(prefs.low_cash_alert_threshold),
      });
      setPrefs(saved);
      setNotice(t("common.saved"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setSavingPrefs(false);
    }
  }

  async function addKey() {
    setError(null);
    try {
      await callApi("gemini.addKey", { label: newKeyLabel || "Key", raw_key: newKeyValue });
      setNewKeyLabel(""); setNewKeyValue("");
      await load();
      setNotice(t("settings.keyAdded"));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Failed to add key");
    }
  }

  async function removeKey(id: string) {
    setWorkingKeyId(id);
    setError(null);
    try {
      await callApi("gemini.removeKey", { key_ref_id: id });
      await load();
      if (prefs?.selected_gemini_model) setPrefs({ ...prefs, selected_gemini_model: null });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setWorkingKeyId(null);
    }
  }

  async function refreshModels(keyId: string) {
    setWorkingKeyId(keyId);
    setError(null);
    setNotice(null);
    try {
      const res = await callApi<{ models: string[] }>("gemini.listModels", { key_ref_id: keyId });
      setModels(res.models);
      setNotice(`${res.models.length} ${t("settings.modelsLoaded")}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    } finally {
      setWorkingKeyId(null);
    }
  }

  async function selectModel(model: string) {
    setError(null);
    try {
      await callApi("gemini.selectModel", { model });
      if (prefs) setPrefs({ ...prefs, selected_gemini_model: model });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t("common.error"));
    }
  }

  if (!prefs) return <div className="loading-state">{t("common.loading")}</div>;

  return (
    <div>
      <div className="card">
        <h3>{t("settings.shopNames")}</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Used to auto-detect Sale slips during OCR (matched against the slip's merchant field).
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 400 }}>
          {[1, 2, 3].map((i) => (
            <input key={i} placeholder={`Shop ${i}`} value={prefs[`shop_name_${i}` as keyof Prefs] as string} onChange={(e) => setPrefs({ ...prefs, [`shop_name_${i}`]: e.target.value } as Prefs)} />
          ))}
        </div>
      </div>

      <div className="card">
        <h3>{t("settings.expenseHolders")}</h3>
        <p style={{ color: "var(--text-muted)", fontSize: "0.85rem" }}>
          Used to auto-detect Expense slips during OCR (matched against the slip's holder field).
        </p>
        <div style={{ display: "grid", gap: 8, maxWidth: 400 }}>
          {[1, 2, 3].map((i) => (
            <input key={i} placeholder={`Holder ${i}`} value={prefs[`expense_holder_${i}` as keyof Prefs] as string} onChange={(e) => setPrefs({ ...prefs, [`expense_holder_${i}`]: e.target.value } as Prefs)} />
          ))}
        </div>
      </div>

      <div className="card">
        <h3>{t("settings.preferencesValues")}</h3>
        <div style={{ display: "grid", gap: 8, maxWidth: 400 }}>
          <label>{t("settings.khrPerUsd")}<input type="number" min="1" step="0.01" value={prefs.khr_per_usd} onChange={(e) => setPrefs({ ...prefs, khr_per_usd: Number(e.target.value) })} /></label>
          <label>{t("settings.lowCashThreshold")}<input type="number" min="0" step="0.01" value={prefs.low_cash_alert_threshold} onChange={(e) => setPrefs({ ...prefs, low_cash_alert_threshold: Number(e.target.value) })} /></label>
          <button className="btn" disabled={savingPrefs} onClick={savePrefs}>{savingPrefs ? t("common.loading") : t("common.save")}</button>
        </div>
      </div>

      <div className="card">
        <h3>{t("settings.gemini")}</h3>
        <table>
          <thead><tr><th>Label</th><th>Key</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td>••••••••{k.masked_last4}</td>
                <td>{k.last_test_ok === null ? "untested" : k.last_test_ok ? "✅ ok" : `❌ ${k.last_error ?? "failed"}`}</td>
                <td>
                  <button className="btn secondary" disabled={workingKeyId !== null} onClick={() => refreshModels(k.id)}>{t("settings.refreshModels")}</button>
                  <button className="btn danger" disabled={workingKeyId !== null} onClick={() => removeKey(k.id)} style={{ marginLeft: 6 }}>{t("common.delete")}</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <input placeholder="Label" value={newKeyLabel} onChange={(e) => setNewKeyLabel(e.target.value)} />
          <input placeholder="Gemini API key" type="password" value={newKeyValue} onChange={(e) => setNewKeyValue(e.target.value)} style={{ flex: 1 }} />
          <button className="btn" disabled={!newKeyValue || workingKeyId !== null} onClick={addKey}>{t("settings.addKey")}</button>
        </div>

        {models.length > 0 && (
          <div style={{ marginTop: 12 }}>
            <label>{t("settings.model")}: </label>
            <select value={prefs.selected_gemini_model ?? ""} onChange={(e) => selectModel(e.target.value)}>
              <option value="" disabled>{t("settings.chooseModel")}</option>
              {models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </div>
        )}
      </div>

      {notice && <div className="success-state">{notice}</div>}
      {error && <div className="error-state">{error}</div>}
    </div>
  );
}
