// supabase/functions/telegram-webhook/sales.ts
// Ports Transaction.gs (bank text -> auto-save), MissingTransaction.gs
// (multi-step manual entry), DeleteTransaction.gs (confirm/cancel
// delete), and the Sale-related parts of Reports.gs.

import { callRpc } from "../_shared/supabaseAdmin.ts";
import { sendMessage } from "./telegram.ts";
import { t } from "./i18n.ts";
import { setState, clearState, setTemp, getTemp, clearTempBatch } from "./db.ts";
import { parseBankText, resolveDatePreset, labelForPreset, type DatePresetKey } from "./parsers.ts";
import { confirmCancelKeyboard, currencyKeyboard, datePresetsKeyboard } from "./keyboards.ts";
import type { BotContext } from "./types.ts";

const MISSING_KEYS = [
  "missing_date", "missing_time", "missing_customer", "missing_amount",
  "missing_currency", "missing_merchant", "missing_remark", "missing_trxid",
];

/**
 * Handles any free-text message when the chat has no active state.
 * Returns true if the text was consumed as a bank notification.
 */
export async function tryHandleBankText(ctx: BotContext, text: string): Promise<boolean> {
  const parsed = parseBankText(text);
  if (!parsed) return false;

  try {
    const sale = await callRpc<{ id: string; customer_name: string; amount: number; currency: string; trx_id: string }>(
      "create_sale",
      {
        p_user_id: ctx.appUser.id,
        p_transaction_at: new Date().toISOString(),
        p_customer_name: parsed.customerName,
        p_amount: parsed.amount,
        p_currency: parsed.currency,
        p_merchant: "",
        p_remark: "",
        p_trx_id: parsed.trxId,
        p_source: "bank_text",
        p_raw_text: text,
        p_actor_user_id: ctx.appUser.id,
        p_user_timezone: ctx.appUser.timezone,
      },
    );

    await sendMessage(ctx.chatId, t(ctx.appUser.language, "sale_saved", {
      customer: sale.customer_name, amount: `${sale.currency} ${sale.amount}`, trxId: sale.trx_id,
    }));
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.startsWith("DUPLICATE_REFERENCE")) {
      await sendMessage(ctx.chatId, t(ctx.appUser.language, "duplicate_reference", { trxId: parsed.trxId }));
    } else {
      console.error("create_sale failed for bank text:", msg);
      await sendMessage(ctx.chatId, t(ctx.appUser.language, "generic_error"));
    }
  }
  return true;
}

export async function startMissingSaleFlow(ctx: BotContext): Promise<void> {
  await clearTempBatch(ctx.chatId, MISSING_KEYS);
  await setState(ctx.chatId, "missing_sale_date");
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "ask_missing_date"));
}

/** Routes a free-text message while inside the missing-sale state chain. */
export async function handleMissingSaleStep(ctx: BotContext, state: string, text: string): Promise<void> {
  const lang = ctx.appUser.language;

  if (state === "missing_sale_date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
      await sendMessage(ctx.chatId, t(lang, "ask_missing_date"));
      return;
    }
    await setTemp(ctx.chatId, "missing_date", text.trim());
    await setState(ctx.chatId, "missing_sale_time");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_time"));
    return;
  }

  if (state === "missing_sale_time") {
    if (!/^\d{1,2}:\d{2}$/.test(text.trim())) {
      await sendMessage(ctx.chatId, t(lang, "ask_missing_time"));
      return;
    }
    await setTemp(ctx.chatId, "missing_time", text.trim());
    await setState(ctx.chatId, "missing_sale_customer");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_customer"));
    return;
  }

  if (state === "missing_sale_customer") {
    await setTemp(ctx.chatId, "missing_customer", text.trim() || "-");
    await setState(ctx.chatId, "missing_sale_amount");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_amount"));
    return;
  }

  if (state === "missing_sale_amount") {
    const amount = parseFloat(text.trim());
    if (Number.isNaN(amount) || amount <= 0) {
      await sendMessage(ctx.chatId, t(lang, "invalid_amount"));
      return;
    }
    await setTemp(ctx.chatId, "missing_amount", String(amount));
    await setState(ctx.chatId, "missing_sale_currency");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_currency"), { replyMarkup: currencyKeyboard("MISSING_SALE_CCY") });
    return;
  }

  if (state === "missing_sale_merchant") {
    await setTemp(ctx.chatId, "missing_merchant", text.trim() || "-");
    await setState(ctx.chatId, "missing_sale_remark");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_remark"));
    return;
  }

  if (state === "missing_sale_remark") {
    await setTemp(ctx.chatId, "missing_remark", text.trim() || "-");
    await setState(ctx.chatId, "missing_sale_trxid");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_trxid"));
    return;
  }

  if (state === "missing_sale_trxid") {
    await setTemp(ctx.chatId, "missing_trxid", text.trim());
    await finalizeMissingSale(ctx);
    return;
  }
}

/** Called from the callback-query router when the currency button is pressed. */
export async function handleMissingSaleCurrencyChoice(ctx: BotContext, currency: "USD" | "KHR"): Promise<void> {
  await setTemp(ctx.chatId, "missing_currency", currency);
  await setState(ctx.chatId, "missing_sale_merchant");
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "ask_missing_merchant"));
}

async function finalizeMissingSale(ctx: BotContext): Promise<void> {
  const lang = ctx.appUser.language;
  const [date, time, customer, amount, currency, merchant, remark, trxId] = await Promise.all(
    MISSING_KEYS.map((k) => getTemp(ctx.chatId, k)),
  );

  try {
    const txnAt = new Date(`${date}T${time}:00`);
    const sale = await callRpc<{ customer_name: string; amount: number; currency: string; trx_id: string }>("create_sale", {
      p_user_id: ctx.appUser.id,
      p_transaction_at: txnAt.toISOString(),
      p_customer_name: customer,
      p_amount: parseFloat(amount ?? "0"),
      p_currency: currency,
      p_merchant: merchant,
      p_remark: remark,
      p_trx_id: trxId,
      p_source: "manual_missing",
      p_raw_text: "",
      p_actor_user_id: ctx.appUser.id,
      p_user_timezone: ctx.appUser.timezone,
    });

    await sendMessage(ctx.chatId, t(lang, "sale_saved", {
      customer: sale.customer_name, amount: `${sale.currency} ${sale.amount}`, trxId: sale.trx_id,
    }));
  } catch (e) {
    const msg = (e as Error).message ?? "";
    if (msg.startsWith("DUPLICATE_REFERENCE")) {
      await sendMessage(ctx.chatId, t(lang, "duplicate_reference", { trxId: trxId ?? "" }));
    } else if (msg.startsWith("MISSING_TRX_ID")) {
      await sendMessage(ctx.chatId, t(lang, "missing_trx_id"));
    } else {
      console.error("create_sale (missing flow) failed:", msg);
      await sendMessage(ctx.chatId, t(lang, "generic_error"));
    }
  } finally {
    await clearTempBatch(ctx.chatId, MISSING_KEYS);
    await clearState(ctx.chatId);
  }
}

// ---------------------------------------------------------------------------
// Delete Sale (spec §26 / legacy DeleteTransaction.gs)
// ---------------------------------------------------------------------------

export async function startDeleteSaleFlow(ctx: BotContext): Promise<void> {
  await setState(ctx.chatId, "sale_delete_trxid");
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "ask_missing_trxid"));
}

export async function handleDeleteSaleTrxIdInput(ctx: BotContext, text: string): Promise<void> {
  const lang = ctx.appUser.language;
  const sale = await callRpc<Record<string, unknown> | null>("find_sale_by_trx_id", {
    p_user_id: ctx.appUser.id, p_trx_id: text.trim(),
  });

  await clearState(ctx.chatId);

  if (!sale) {
    await sendMessage(ctx.chatId, t(lang, "petty_not_found", { displayId: text.trim() }));
    return;
  }

  await setTemp(ctx.chatId, "delete_sale_id", sale.id as string);
  await sendMessage(
    ctx.chatId,
    t(lang, "confirm_delete_sale", {
      date: String(sale.transaction_at), name: String(sale.customer_name),
      amount: `${sale.currency} ${sale.amount}`, merchant: String(sale.merchant), trxId: String(sale.trx_id),
    }),
    { replyMarkup: confirmCancelKeyboard(lang, "SALE:DELETE:CONFIRM", "SALE:DELETE:CANCEL") },
  );
}

export async function confirmDeleteSale(ctx: BotContext): Promise<void> {
  const lang = ctx.appUser.language;
  const saleId = await getTemp(ctx.chatId, "delete_sale_id");
  if (!saleId) return;

  await callRpc("delete_sale", { p_user_id: ctx.appUser.id, p_sale_id: saleId, p_actor_user_id: ctx.appUser.id });
  await clearTempBatch(ctx.chatId, ["delete_sale_id"]);
  await sendMessage(ctx.chatId, t(lang, "sale_deleted"));
}

// ---------------------------------------------------------------------------
// Reports (spec: Reports.gs today/yesterday/weekly/monthly/date-range)
// ---------------------------------------------------------------------------

export async function sendSaleReportMenu(ctx: BotContext): Promise<void> {
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "export_choose_period"), {
    replyMarkup: datePresetsKeyboard(ctx.appUser.language, "SALE_REPORT"),
  });
}

export async function sendSaleReportForPreset(ctx: BotContext, preset: DatePresetKey): Promise<void> {
  const { start, end } = resolveDatePreset(preset, ctx.appUser.timezone);
  const summary = await callRpc<{ transaction_count: number; usd_total: number; khr_total: number }>("sale_summary", {
    p_user_id: ctx.appUser.id, p_start: start.toISOString(), p_end: end.toISOString(),
  });

  await sendMessage(ctx.chatId, t(ctx.appUser.language, "sale_summary", {
    period: labelForPreset(preset, ctx.appUser.language), count: summary.transaction_count,
    usd: summary.usd_total.toFixed(2), khr: summary.khr_total.toFixed(0),
  }));
}
