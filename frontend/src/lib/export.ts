function escapeCsvCell(value: unknown): string {
  let text = value == null ? "" : String(value);
  // Prevent common spreadsheet formula injection when CSV is opened in Excel.
  if (/^[=+\-@]/.test(text)) text = `\t${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: unknown[][],
): void {
  const csv = [
    headers.map(escapeCsvCell).join(","),
    ...rows.map((row) => row.map(escapeCsvCell).join(",")),
  ].join("\r\n");
  const blob = new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function openPrintReportWindow(): Window {
  const popup = window.open("", "_blank", "width=1100,height=800");
  if (!popup) throw new Error("POPUP_BLOCKED: please allow pop-ups for printing");
  return popup;
}

export function renderPrintReport(
  popup: Window,
  title: string,
  subtitle: string,
  headers: string[],
  rows: unknown[][],
  totals: Array<[string, unknown]> = [],
): void {
  const tableHead = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const tableRows = rows
    .map((row) => `<tr>${row.map((cell) => `<td>${escapeHtml(cell)}</td>`).join("")}</tr>`)
    .join("");
  const totalsHtml = totals.length > 0
    ? `<div class="totals">${totals.map(([label, value]) => `<div><strong>${escapeHtml(label)}</strong>: ${escapeHtml(value)}</div>`).join("")}</div>`
    : "";

  popup.document.open();
  popup.document.write(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Noto Sans Khmer", "Segoe UI", sans-serif; color: #111; font-size: 11px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { color: #555; margin-bottom: 12px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: 1px solid #bbb; padding: 5px 6px; text-align: left; vertical-align: top; }
  th { background: #eee; }
  tr { break-inside: avoid; }
  .totals { margin-top: 12px; display: grid; gap: 4px; }
</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<div class="subtitle">${escapeHtml(subtitle)}</div>
<table><thead><tr>${tableHead}</tr></thead><tbody>${tableRows}</tbody></table>
${totalsHtml}
<script>
  window.addEventListener('load', () => {
    setTimeout(() => { window.print(); }, 80);
  });
  window.addEventListener('afterprint', () => { window.close(); });
</script>
</body>
</html>`);
  popup.document.close();
}

export function printReport(
  title: string,
  subtitle: string,
  headers: string[],
  rows: unknown[][],
  totals: Array<[string, unknown]> = [],
): void {
  const popup = openPrintReportWindow();
  renderPrintReport(popup, title, subtitle, headers, rows, totals);
}

export function dateKeyInTimezone(timeZone: string | undefined): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}
