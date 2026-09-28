import { useApp } from "../contexts/AppContext";

export function SummaryCard({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div className={`summary-card${warning ? " warning" : ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}

export function ConfirmModal({
  title, lines, onConfirm, onCancel,
}: { title: string; lines: string[]; onConfirm: () => void; onCancel: () => void }) {
  const { t } = useApp();
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {lines.map((l, i) => <div key={i}>{l}</div>)}
        <div className="actions">
          <button className="btn secondary" onClick={onCancel}>{t("common.cancel")}</button>
          <button className="btn danger" onClick={onConfirm}>{t("common.confirm")}</button>
        </div>
      </div>
    </div>
  );
}

export type DatePreset = "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "THIS_MONTH" | "LAST_MONTH" | "CUSTOM";

export function DatePresetFilters({
  value,
  onChange,
  customStart,
  customEnd,
  onCustomChange,
}: {
  value: DatePreset;
  onChange: (p: DatePreset) => void;
  customStart?: string;
  customEnd?: string;
  onCustomChange?: (start: string, end: string) => void;
}) {
  const { t } = useApp();
  const presets: { key: DatePreset; label: string }[] = [
    { key: "TODAY", label: t("common.today") },
    { key: "YESTERDAY", label: t("common.yesterday") },
    { key: "THIS_WEEK", label: t("common.thisWeek") },
    { key: "LAST_WEEK", label: t("common.lastWeek") },
    { key: "THIS_MONTH", label: t("common.thisMonth") },
    { key: "LAST_MONTH", label: t("common.lastMonth") },
    { key: "CUSTOM", label: t("common.customRange") },
  ];
  return (
    <div className="filters">
      {presets.map((p) => (
        <button key={p.key} className={value === p.key ? "active" : ""} onClick={() => onChange(p.key)}>
          {p.label}
        </button>
      ))}
      {value === "CUSTOM" && onCustomChange && (
        <>
          <label>{t("common.from")}
            <input
              type="date"
              value={customStart ?? ""}
              onChange={(e) => onCustomChange(e.target.value, customEnd ?? e.target.value)}
            />
          </label>
          <label>{t("common.to")}
            <input
              type="date"
              value={customEnd ?? ""}
              min={customStart || undefined}
              onChange={(e) => onCustomChange(customStart ?? e.target.value, e.target.value)}
            />
          </label>
        </>
      )}
    </div>
  );
}

export function dateKeyInTimezone(timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function addDays(dateKey: string, days: number): string {
  const d = new Date(`${dateKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function zonedDateTimeToIso(dateKey: string, timeText: string, timeZone: string): string {
  // Solve UTC = local - zoneOffset. Iteration handles DST transitions without
  // requiring a third-party timezone package in the browser bundle.
  const desired = Date.parse(`${dateKey}T${timeText}Z`);
  let candidate = desired;
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  for (let i = 0; i < 4; i++) {
    const parts = formatter.formatToParts(new Date(candidate));
    const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    const seen = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`);
    candidate += desired - seen;
  }
  return new Date(candidate).toISOString();
}

export function resolvePresetRange(
  preset: DatePreset,
  custom?: { start: string; end: string },
  userTimezone?: string,
): { start: string; end: string } {
  const timeZone = userTimezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Phnom_Penh";
  const today = dateKeyInTimezone(timeZone);
  const startIso = (dateKey: string) => zonedDateTimeToIso(dateKey, "00:00:00", timeZone);
  const endIso = (dateKey: string) => new Date(new Date(startIso(addDays(dateKey, 1))).getTime() - 1).toISOString();

  let startDate = today;
  let endDate = today;

  switch (preset) {
    case "YESTERDAY":
      startDate = endDate = addDays(today, -1);
      break;
    case "THIS_WEEK": {
      const day = new Date(`${today}T00:00:00Z`).getUTCDay();
      startDate = addDays(today, day === 0 ? -6 : 1 - day);
      break;
    }
    case "LAST_WEEK": {
      const day = new Date(`${today}T00:00:00Z`).getUTCDay();
      const thisMonday = addDays(today, day === 0 ? -6 : 1 - day);
      startDate = addDays(thisMonday, -7);
      endDate = addDays(thisMonday, -1);
      break;
    }
    case "THIS_MONTH":
      startDate = `${today.slice(0, 7)}-01`;
      break;
    case "LAST_MONTH": {
      const firstThis = new Date(`${today.slice(0, 7)}-01T00:00:00Z`);
      firstThis.setUTCDate(0);
      endDate = firstThis.toISOString().slice(0, 10);
      startDate = `${endDate.slice(0, 7)}-01`;
      break;
    }
    case "CUSTOM":
      if (custom?.start && custom?.end && custom.start <= custom.end) {
        startDate = custom.start;
        endDate = custom.end;
      }
      break;
    case "TODAY":
    default:
      break;
  }

  return { start: startIso(startDate), end: endIso(endDate) };
}
