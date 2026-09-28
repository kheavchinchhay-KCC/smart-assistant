// supabase/functions/telegram-webhook/export.ts
// Telegram exports: private Supabase Storage + expiring signed URL.
// ExcelJS handles XLSX; pdf-lib + Noto Sans Khmer handle Unicode/Khmer PDF output.

import ExcelJS from "npm:exceljs@4";
import { PDFDocument, rgb, type PDFFont, type PDFPage } from "npm:pdf-lib@1.17.1";
import fontkit from "npm:@pdf-lib/fontkit@1.1.1";
import { getAdminClient, callRpc } from "../_shared/supabaseAdmin.ts";
import { sendMessage, sendDocument } from "./telegram.ts";
import { t } from "./i18n.ts";
import { setTemp, getTemp, clearTempBatch } from "./db.ts";
import { resolveDatePreset, labelForPreset, type DatePresetKey } from "./parsers.ts";
import { exportDataKeyboard, exportFormatKeyboard, datePresetsKeyboard } from "./keyboards.ts";
import type { BotContext } from "./types.ts";

type ExportDataType = "sale" | "petty_cash";
type ExportFormat = "xlsx" | "pdf";

const MAX_EXPORT_ROWS = 50_000;
const STORAGE_SAFE_LIMIT = 18 * 1024 * 1024;
const KHMER_FONT_URLS = [
  "https://notofonts.github.io/khmer/fonts/NotoSansKhmer/googlefonts/ttf/NotoSansKhmer-Regular.ttf",
  "https://raw.githubusercontent.com/notofonts/noto-fonts/main/hinted/ttf/NotoSansKhmer/NotoSansKhmer-Regular.ttf",
];
let khmerFontBytes: Uint8Array | null = null;

interface SaleExportRow {
  transaction_at: string;
  customer_name: string;
  amount: number;
  currency: string;
  merchant: string;
  remark: string;
  trx_id: string;
  source: string;
}

interface PettyExportRow {
  display_id: string;
  transaction_at: string;
  type: string;
  amount: number;
  remark: string;
  running_balance: number;
  source: string;
  mode: string;
}

export async function startExportFlow(ctx: BotContext): Promise<void> {
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "export_choose_data"), {
    replyMarkup: exportDataKeyboard(ctx.appUser.language),
  });
}

export async function handleExportDataChoice(ctx: BotContext, dataType: ExportDataType): Promise<void> {
  await setTemp(ctx.chatId, "export_data_type", dataType);
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "export_choose_period"), {
    replyMarkup: datePresetsKeyboard(ctx.appUser.language, "EXPORT_PERIOD"),
  });
}

export async function handleExportPeriodChoice(ctx: BotContext, preset: DatePresetKey): Promise<void> {
  const { start, end } = resolveDatePreset(preset, ctx.appUser.timezone);
  await setTemp(ctx.chatId, "export_start", start.toISOString());
  await setTemp(ctx.chatId, "export_end", end.toISOString());
  await setTemp(ctx.chatId, "export_period_label", labelForPreset(preset, ctx.appUser.language));
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "export_choose_format"), {
    replyMarkup: exportFormatKeyboard(ctx.appUser.language),
  });
}

export async function handleExportFormatChoice(ctx: BotContext, format: ExportFormat): Promise<void> {
  const lang = ctx.appUser.language;
  await sendMessage(ctx.chatId, t(lang, "export_generating"));

  const [dataType, startIso, endIso, periodLabel] = await Promise.all(
    ["export_data_type", "export_start", "export_end", "export_period_label"].map((k) => getTemp(ctx.chatId, k)),
  );
  await clearTempBatch(ctx.chatId, ["export_data_type", "export_start", "export_end", "export_period_label"]);

  if (dataType !== "sale" && dataType !== "petty_cash") {
    await sendMessage(ctx.chatId, t(lang, "generic_error"));
    return;
  }
  if (!startIso || !endIso || !periodLabel) {
    await sendMessage(ctx.chatId, t(lang, "generic_error"));
    return;
  }

  try {
    const rows = dataType === "sale"
      ? await loadSaleRows(ctx.appUser.id, startIso, endIso)
      : await loadPettyRows(ctx.appUser.id, startIso, endIso);

    const buffer = format === "xlsx"
      ? dataType === "sale"
        ? await buildSaleWorkbook(ctx, rows as SaleExportRow[], periodLabel)
        : await buildPettyWorkbook(ctx, rows as PettyExportRow[], periodLabel)
      : dataType === "sale"
        ? await buildSalePdf(ctx, rows as SaleExportRow[], periodLabel)
        : await buildPettyPdf(ctx, rows as PettyExportRow[], periodLabel);

    if (buffer.byteLength > STORAGE_SAFE_LIMIT) {
      throw new Error("EXPORT_TOO_LARGE: generated file is above the safe Storage limit; narrow the date range and retry");
    }

    const extension = format === "xlsx" ? "xlsx" : "pdf";
    const contentType = format === "xlsx"
      ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      : "application/pdf";
    const objectPath = `${ctx.appUser.id}/${crypto.randomUUID()}.${extension}`;

    const storage = getAdminClient().storage.from("exports");
    const { error: uploadError } = await storage.upload(objectPath, buffer, {
      contentType,
      upsert: false,
    });
    if (uploadError) throw new Error(uploadError.message);

    try {
      const { data: signed, error: signError } = await storage.createSignedUrl(objectPath, 60 * 15);
      if (signError || !signed) throw new Error(signError?.message ?? "failed to sign export URL");

      await callRpc("write_audit_log", {
        p_actor_user_id: ctx.appUser.id,
        p_action: "export.generated",
        p_target_type: "exports",
        p_target_id: objectPath,
        p_details: { data_type: dataType, format, period: periodLabel, row_count: rows.length },
      });

      const { error: insertError } = await getAdminClient().from("exports").insert({
        user_id: ctx.appUser.id,
        export_type: dataType,
        format,
        start_at: startIso,
        end_at: endIso,
        storage_object_path: objectPath,
        row_count: rows.length,
        requested_via: "telegram",
      });
      if (insertError) throw new Error(insertError.message);

      await sendDocument(ctx.chatId, signed.signedUrl, t(lang, "export_ready"));
    } catch (inner) {
      await storage.remove([objectPath]).catch((cleanupError) => console.error("Export cleanup failed:", cleanupError));
      throw inner;
    }
  } catch (e) {
    console.error("Export generation failed:", (e as Error).message);
    const message = String((e as Error).message ?? "");
    if (message.startsWith("EXPORT_TOO_LARGE")) {
      await sendMessage(ctx.chatId, t(lang, "export_too_large"));
      return;
    }
    await sendMessage(ctx.chatId, t(lang, "generic_error"));
  }
}

async function loadSaleRows(userId: string, startIso: string, endIso: string): Promise<SaleExportRow[]> {
  const rows: SaleExportRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += pageSize) {
    const page = await callRpc<Array<SaleExportRow & { total_count?: number }>>("search_sales", {
      p_user_id: userId,
      p_keyword: "",
      p_start: startIso,
      p_end: endIso,
      p_limit: pageSize,
      p_offset: offset,
    });
    const clean = (page ?? []).map(({ total_count: _totalCount, ...row }) => row);
    rows.push(...clean);
    if (!page || page.length < pageSize) return rows;
    if (Number(page[0]?.total_count ?? rows.length) <= rows.length) return rows;
  }
  throw new Error("EXPORT_TOO_LARGE: more than 50,000 rows match this export");
}

async function loadPettyRows(userId: string, startIso: string, endIso: string): Promise<PettyExportRow[]> {
  const rows: PettyExportRow[] = [];
  const pageSize = 1000;
  for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += pageSize) {
    const page = await callRpc<Array<PettyExportRow & { total_count?: number }>>("search_petty", {
      p_user_id: userId,
      p_keyword: "",
      p_start: startIso,
      p_end: endIso,
      p_limit: pageSize,
      p_offset: offset,
    });
    const clean = (page ?? []).map(({ total_count: _totalCount, ...row }) => row);
    rows.push(...clean);
    if (!page || page.length < pageSize) return rows;
    if (Number(page[0]?.total_count ?? rows.length) <= rows.length) return rows;
  }
  throw new Error("EXPORT_TOO_LARGE: more than 50,000 rows match this export");
}

function displayDateTime(value: string, timezone: string): { date: string; time: string } {
  const d = new Date(value);
  return {
    date: new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(d),
  };
}

async function buildSaleWorkbook(ctx: BotContext, rows: SaleExportRow[], periodLabel: string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sale");
  ws.addRow([`Sale Report — ${periodLabel}`]);
  ws.addRow([`Generated: ${new Date().toISOString()}  User: ${ctx.appUser.display_name}`]);
  ws.addRow([]);
  ws.addRow(["Date", "Time", "Name", "Amount", "Currency", "Merchant", "Remark", "Trx ID", "Source"]);

  let usdTotal = 0;
  let khrTotal = 0;
  for (const r of rows) {
    const dt = displayDateTime(r.transaction_at, ctx.appUser.timezone);
    ws.addRow([dt.date, dt.time, r.customer_name, Number(r.amount), r.currency, r.merchant, r.remark, r.trx_id, r.source]);
    if (r.currency === "USD") usdTotal += Number(r.amount);
    if (r.currency === "KHR") khrTotal += Number(r.amount);
  }

  ws.addRow([]);
  ws.addRow(["", "", "", "", "", "", "", "Total USD:", usdTotal.toFixed(2)]);
  ws.addRow(["", "", "", "", "", "", "", "Total KHR:", khrTotal.toFixed(0)]);
  ws.columns.forEach((column, index) => { column.width = [14, 12, 24, 14, 10, 22, 32, 24, 14][index] ?? 14; });
  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.autoFilter = { from: "A4", to: "I4" };
  const header = ws.getRow(4);
  header.font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

async function buildPettyWorkbook(ctx: BotContext, rows: PettyExportRow[], periodLabel: string): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Petty Cash");
  ws.addRow([`Petty Cash Report — ${periodLabel}`]);
  ws.addRow([`Generated: ${new Date().toISOString()}  User: ${ctx.appUser.display_name}`]);
  ws.addRow([]);
  ws.addRow(["Petty ID", "Date", "Time", "Type", "Amount", "Remark", "Running Balance", "Source", "Mode"]);

  let cashIn = 0;
  let expense = 0;
  for (const r of rows) {
    const dt = displayDateTime(r.transaction_at, ctx.appUser.timezone);
    ws.addRow([r.display_id, dt.date, dt.time, r.type, Number(r.amount), r.remark, Number(r.running_balance), r.source, r.mode]);
    if (r.type === "IN") cashIn += Number(r.amount);
    if (r.type === "OUT") expense += Number(r.amount);
  }

  const currentCash = await callRpc<number>("current_petty_cash_balance", { p_user_id: ctx.appUser.id });
  ws.addRow([]);
  ws.addRow(["", "", "", "Cash In:", cashIn.toFixed(2)]);
  ws.addRow(["", "", "", "Expense:", expense.toFixed(2)]);
  ws.addRow(["", "", "", "Current Cash:", Number(currentCash).toFixed(2)]);
  ws.columns.forEach((column, index) => { column.width = [16, 14, 12, 12, 14, 34, 18, 14, 12][index] ?? 14; });
  ws.views = [{ state: "frozen", ySplit: 4 }];
  ws.autoFilter = { from: "A4", to: "I4" };
  ws.getRow(4).font = { bold: true };

  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}

async function getKhmerFontBytes(): Promise<Uint8Array> {
  if (khmerFontBytes) return khmerFontBytes;
  let lastError: unknown = null;
  for (const url of KHMER_FONT_URLS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      const res = await fetch(url, { redirect: "follow", signal: controller.signal });
      if (!res.ok) {
        lastError = new Error(`PDF_FONT_HTTP_${res.status}: could not fetch Noto Sans Khmer`);
        continue;
      }
      khmerFontBytes = new Uint8Array(await res.arrayBuffer());
      return khmerFontBytes;
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("PDF_FONT_DOWNLOAD_FAILED: could not fetch Noto Sans Khmer");
}

function pageSetup(pdfDoc: PDFDocument, font: PDFFont, title: string, subtitle: string): { page: PDFPage; y: number; margin: number; width: number; font: PDFFont } {
  const page = pdfDoc.addPage([841.89, 595.28]); // A4 landscape
  const margin = 28;
  page.drawText(title, { x: margin, y: 565, size: 16, font });
  page.drawText(subtitle, { x: margin, y: 545, size: 8, font });
  return { page, y: 520, margin, width: 841.89 - margin * 2, font };
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const normalized = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) return [""];
  const words = normalized.includes(" ") ? normalized.split(" ") : Array.from(normalized);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line}${normalized.includes(" ") ? " " : ""}${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      line = candidate;
    } else if (line) {
      lines.push(line);
      line = word;
      if (font.widthOfTextAtSize(line, size) > maxWidth) {
        let fragment = "";
        for (const ch of Array.from(line)) {
          const c = fragment + ch;
          if (font.widthOfTextAtSize(c, size) > maxWidth && fragment) {
            lines.push(fragment);
            fragment = ch;
          } else {
            fragment = c;
          }
        }
        line = fragment;
      }
    } else {
      let fragment = "";
      for (const ch of Array.from(word)) {
        const c = fragment + ch;
        if (font.widthOfTextAtSize(c, size) > maxWidth && fragment) {
          lines.push(fragment);
          fragment = ch;
        } else {
          fragment = c;
        }
      }
      line = fragment;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 4) return lines.length ? lines : [""];
  const clipped = lines.slice(0, 4);
  clipped[3] = `${clipped[3].replace(/\s+$/u, "")}…`;
  return clipped;
}

function drawTable(
  pdfDoc: PDFDocument,
  state: { page: PDFPage; y: number; margin: number; width: number; font: PDFFont },
  headers: string[],
  rows: string[][],
  widths: number[],
): { page: PDFPage; y: number } {
  const fontSize = 7.5;
  const lineHeight = 9;
  const cellPad = 3;
  const tableTop = state.y;

  const drawHeader = (page: PDFPage, top: number): number => {
    let x = state.margin;
    const h = 18;
    headers.forEach((header, i) => {
      page.drawRectangle({ x, y: top - h, width: widths[i], height: h, color: rgb(0.93, 0.93, 0.93), borderColor: rgb(0.55, 0.55, 0.55), borderWidth: 0.5 });
      page.drawText(header, { x: x + cellPad, y: top - 12, size: fontSize, font: state.font });
      x += widths[i];
    });
    return top - h;
  };

  let page = state.page;
  let y = drawHeader(page, tableTop);

  for (const row of rows) {
    const wrapped = row.map((value, i) => wrapText(value, state.font, fontSize, widths[i] - cellPad * 2));
    const lines = Math.max(...wrapped.map((v) => v.length));
    const rowHeight = Math.max(16, lines * lineHeight + cellPad * 2);

    if (y - rowHeight < 30) {
      page = pdfDoc.addPage([841.89, 595.28]);
      y = 550;
      y = drawHeader(page, y);
    }

    let x = state.margin;
    row.forEach((_value, i) => {
      page.drawRectangle({ x, y: y - rowHeight, width: widths[i], height: rowHeight, borderColor: rgb(0.78, 0.78, 0.78), borderWidth: 0.35 });
      wrapped[i].forEach((line, lineIndex) => {
        page.drawText(line, { x: x + cellPad, y: y - cellPad - fontSize - lineIndex * lineHeight, size: fontSize, font: state.font });
      });
      x += widths[i];
    });
    y -= rowHeight;
  }

  return { page, y };
}

async function buildSalePdf(ctx: BotContext, rows: SaleExportRow[], periodLabel: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(await getKhmerFontBytes(), { subset: true });
  const state = pageSetup(pdfDoc, font, `Sale Report — ${periodLabel}`, `Generated ${new Date().toISOString()} · User: ${ctx.appUser.display_name}`);

  const data = rows.map((r) => {
    const dt = displayDateTime(r.transaction_at, ctx.appUser.timezone);
    return [dt.date, dt.time, r.customer_name, Number(r.amount).toFixed(r.currency === "KHR" ? 0 : 2), r.currency, r.merchant, r.remark, r.trx_id, r.source];
  });
  drawTable(pdfDoc, state, ["Date", "Time", "Name", "Amount", "Currency", "Merchant", "Remark", "Trx ID", "Source"], data, [62, 50, 92, 58, 48, 90, 145, 105, 60]);

  const usd = rows.filter((r) => r.currency === "USD").reduce((s, r) => s + Number(r.amount), 0);
  const khr = rows.filter((r) => r.currency === "KHR").reduce((s, r) => s + Number(r.amount), 0);
  const summaryPage = pdfDoc.getPages()[pdfDoc.getPageCount() - 1];
  summaryPage.drawText(`Transactions: ${rows.length}   USD: ${usd.toFixed(2)}   KHR: ${khr.toFixed(0)}`, { x: 28, y: 18, size: 8, font });

  return await pdfDoc.save();
}

async function buildPettyPdf(ctx: BotContext, rows: PettyExportRow[], periodLabel: string): Promise<Uint8Array> {
  const pdfDoc = await PDFDocument.create();
  pdfDoc.registerFontkit(fontkit);
  const font = await pdfDoc.embedFont(await getKhmerFontBytes(), { subset: true });
  const state = pageSetup(pdfDoc, font, `Petty Cash Report — ${periodLabel}`, `Generated ${new Date().toISOString()} · User: ${ctx.appUser.display_name}`);

  const data = rows.map((r) => {
    const dt = displayDateTime(r.transaction_at, ctx.appUser.timezone);
    return [r.display_id, dt.date, dt.time, r.type, Number(r.amount).toFixed(2), r.remark, Number(r.running_balance).toFixed(2), r.source, r.mode];
  });
  const result = drawTable(pdfDoc, state, ["Petty ID", "Date", "Time", "Type", "Amount", "Remark", "Running Balance", "Source", "Mode"], data, [70, 62, 50, 45, 60, 180, 105, 80, 65]);

  const cashIn = rows.filter((r) => r.type === "IN").reduce((s, r) => s + Number(r.amount), 0);
  const expense = rows.filter((r) => r.type === "OUT").reduce((s, r) => s + Number(r.amount), 0);
  const currentCash = await callRpc<number>("current_petty_cash_balance", { p_user_id: ctx.appUser.id });
  result.page.drawText(`Rows: ${rows.length}   Cash In: ${cashIn.toFixed(2)}   Expense: ${expense.toFixed(2)}   Current Cash: ${Number(currentCash).toFixed(2)}`, { x: 28, y: 18, size: 8, font });

  return await pdfDoc.save();
}
