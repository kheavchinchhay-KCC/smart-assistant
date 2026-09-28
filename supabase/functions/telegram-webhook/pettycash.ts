// supabase/functions/telegram-webhook/pettycash.ts
// Ports PettyCash.gs: Cash In / Expense / Missing / Edit / Delete /
// History / Balance / date-preset summaries. The physical
// sort-then-rewrite balance logic is gone entirely — every save just
// calls create_petty_cash() and the running balance/current cash are
// always read live (petty_cash_running view / current_petty_cash_balance
// function, 0007_petty_cash.sql).

import { callRpc } from "../_shared/supabaseAdmin.ts";
import { sendMessage } from "./telegram.ts";
import { t } from "./i18n.ts";
import { setState, clearState, setTemp, getTemp, clearTempBatch } from "./db.ts";
import { parsePettyFreeText, resolveDatePreset, labelForPreset, type DatePresetKey } from "./parsers.ts";
import { confirmCancelKeyboard, datePresetsKeyboard } from "./keyboards.ts";
import type { BotContext } from "./types.ts";

type PettyType = "IN" | "OUT";

// ---------------------------------------------------------------------------
// Cash In / Expense (immediate, "now") — legacy free-text "<amount> <remark>"
// ---------------------------------------------------------------------------

export async function startCashInOrExpense(ctx: BotContext, type: PettyType): Promise<void> {
  await setTemp(ctx.chatId, "petty_immediate_type", type);
  await setState(ctx.chatId, "petty_immediate_amount");
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "ask_petty_amount_remark"));
}

export async function handlePettyImmediateAmountStep(ctx: BotContext, text: string): Promise<void> {
  const lang = ctx.appUser.language;
  const parsed = parsePettyFreeText(text);
  if (!parsed) {
    await sendMessage(ctx.chatId, t(lang, "invalid_amount"));
    return;
  }

  const type = (await getTemp(ctx.chatId, "petty_immediate_type")) as PettyType;
  await clearState(ctx.chatId);
  await clearTempBatch(ctx.chatId, ["petty_immediate_type"]);
  await savePettyCashAndReport(ctx, type, parsed.amount, parsed.remark, new Date(), "NORMAL");
}

// ---------------------------------------------------------------------------
// Missing / backdated entry (spec: "Missing Cash In", "Missing Expense")
// ---------------------------------------------------------------------------

const MISSING_KEYS = ["petty_missing_type", "petty_missing_date", "petty_missing_time"];

export async function startMissingPettyFlow(ctx: BotContext, type: PettyType): Promise<void> {
  await clearTempBatch(ctx.chatId, MISSING_KEYS);
  await setTemp(ctx.chatId, "petty_missing_type", type);
  await setState(ctx.chatId, "petty_missing_date");
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "ask_missing_date"));
}

export async function handleMissingPettyStep(ctx: BotContext, state: string, text: string): Promise<void> {
  const lang = ctx.appUser.language;

  if (state === "petty_missing_date") {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(text.trim())) {
      await sendMessage(ctx.chatId, t(lang, "ask_missing_date"));
      return;
    }
    await setTemp(ctx.chatId, "petty_missing_date", text.trim());
    await setState(ctx.chatId, "petty_missing_time");
    await sendMessage(ctx.chatId, t(lang, "ask_missing_time"));
    return;
  }

  if (state === "petty_missing_time") {
    if (!/^\d{1,2}:\d{2}$/.test(text.trim())) {
      await sendMessage(ctx.chatId, t(lang, "ask_missing_time"));
      return;
    }
    await setTemp(ctx.chatId, "petty_missing_time", text.trim());
    await setState(ctx.chatId, "petty_missing_amount");
    await sendMessage(ctx.chatId, t(lang, "ask_petty_amount_remark"));
    return;
  }

  if (state === "petty_missing_amount") {
    const parsed = parsePettyFreeText(text);
    if (!parsed) {
      await sendMessage(ctx.chatId, t(lang, "invalid_amount"));
      return;
    }
    const [type, date, time] = await Promise.all(MISSING_KEYS.map((k) => getTemp(ctx.chatId, k)));
    await clearState(ctx.chatId);
    await clearTempBatch(ctx.chatId, MISSING_KEYS);
    const txnAt = new Date(`${date}T${time}:00`);
    await savePettyCashAndReport(ctx, type as PettyType, parsed.amount, parsed.remark, txnAt, "MISSING");
  }
}

async function savePettyCashAndReport(
  ctx: BotContext, type: PettyType, amount: number, remark: string, transactionAt: Date, mode: "NORMAL" | "MISSING",
): Promise<void> {
  const lang = ctx.appUser.language;
  try {
    const row = await callRpc<{ display_id: string; type: string; amount: number }>("create_petty_cash", {
      p_user_id: ctx.appUser.id,
      p_type: type,
      p_amount: amount,
      p_remark: remark,
      p_transaction_at: transactionAt.toISOString(),
      p_reference: null,
      p_mode: mode,
      p_source: "Telegram",
      p_raw_text: "",
      p_created_by: ctx.appUser.id,
      p_slip_job_id: null,
      p_user_timezone: ctx.appUser.timezone,
    });

    const currentCash = await callRpc<number>("current_petty_cash_balance", { p_user_id: ctx.appUser.id });

    await sendMessage(ctx.chatId, t(lang, "petty_saved", {
      displayId: row.display_id, type: row.type, amount: row.amount.toFixed(2), currentCash: currentCash.toFixed(2),
    }));

    const prefs = await callRpc<{ low_cash_alert_threshold: number }>("get_or_create_preferences", { p_user_id: ctx.appUser.id });
    if (currentCash < prefs.low_cash_alert_threshold) {
      await sendMessage(ctx.chatId, t(lang, "low_cash_warning", { currentCash: currentCash.toFixed(2) }));
    }
  } catch (e) {
    console.error("create_petty_cash failed:", (e as Error).message);
    await sendMessage(ctx.chatId, t(lang, "generic_error"));
  }
}

// ---------------------------------------------------------------------------
// Edit (spec: legacy editPettyCashById — amount + remark only)
// ---------------------------------------------------------------------------

export async function startEditPettyFlow(ctx: BotContext): Promise<void> {
  await setState(ctx.chatId, "petty_edit_id");
  await sendMessage(ctx.chatId, "Enter the Petty ID to edit (e.g. PC000123):");
}

export async function handleEditPettyIdStep(ctx: BotContext, text: string): Promise<void> {
  const row = await callRpc<Record<string, unknown> | null>("find_petty_by_display_id", {
    p_user_id: ctx.appUser.id, p_display_id: text.trim(),
  });

  if (!row) {
    await sendMessage(ctx.chatId, t(ctx.appUser.language, "petty_not_found", { displayId: text.trim() }));
    await clearState(ctx.chatId);
    return;
  }

  await setTemp(ctx.chatId, "edit_petty_display_id", text.trim());
  await setState(ctx.chatId, "petty_edit_amount");
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "ask_petty_amount_remark"));
}

export async function handleEditPettyAmountStep(ctx: BotContext, text: string): Promise<void> {
  const lang = ctx.appUser.language;
  const parsed = parsePettyFreeText(text);
  if (!parsed) {
    await sendMessage(ctx.chatId, t(lang, "invalid_amount"));
    return;
  }

  const displayId = await getTemp(ctx.chatId, "edit_petty_display_id");
  await clearState(ctx.chatId);
  await clearTempBatch(ctx.chatId, ["edit_petty_display_id"]);

  const row = await callRpc<{ display_id: string; type: string; amount: number }>("update_petty_cash", {
    p_user_id: ctx.appUser.id, p_display_id: displayId, p_amount: parsed.amount, p_remark: parsed.remark,
    p_actor_user_id: ctx.appUser.id, p_user_timezone: ctx.appUser.timezone,
  });

  const currentCash = await callRpc<number>("current_petty_cash_balance", { p_user_id: ctx.appUser.id });
  await sendMessage(ctx.chatId, t(lang, "petty_saved", {
    displayId: row.display_id, type: row.type, amount: row.amount.toFixed(2), currentCash: currentCash.toFixed(2),
  }));
}

// ---------------------------------------------------------------------------
// Delete (spec §30 — confirm with Petty ID/type/amount/date/remark)
// ---------------------------------------------------------------------------

export async function startDeletePettyFlow(ctx: BotContext): Promise<void> {
  await setState(ctx.chatId, "petty_delete_id");
  await sendMessage(ctx.chatId, "Enter the Petty ID to delete (e.g. PC000123):");
}

export async function handleDeletePettyIdStep(ctx: BotContext, text: string): Promise<void> {
  const lang = ctx.appUser.language;
  const row = await callRpc<Record<string, unknown> | null>("find_petty_by_display_id", {
    p_user_id: ctx.appUser.id, p_display_id: text.trim(),
  });

  await clearState(ctx.chatId);

  if (!row) {
    await sendMessage(ctx.chatId, t(lang, "petty_not_found", { displayId: text.trim() }));
    return;
  }

  await setTemp(ctx.chatId, "delete_petty_display_id", text.trim());
  await sendMessage(
    ctx.chatId,
    t(lang, "confirm_delete_petty", {
      displayId: String(row.display_id), type: String(row.type), amount: String(row.amount), remark: String(row.remark),
    }),
    { replyMarkup: confirmCancelKeyboard(lang, "PC:DELETE:CONFIRM", "PC:DELETE:CANCEL") },
  );
}

export async function confirmDeletePetty(ctx: BotContext): Promise<void> {
  const lang = ctx.appUser.language;
  const displayId = await getTemp(ctx.chatId, "delete_petty_display_id");
  if (!displayId) return;

  await callRpc("delete_petty_cash", { p_user_id: ctx.appUser.id, p_display_id: displayId, p_actor_user_id: ctx.appUser.id });
  await clearTempBatch(ctx.chatId, ["delete_petty_display_id"]);
  await sendMessage(ctx.chatId, t(lang, "petty_deleted"));
}

// ---------------------------------------------------------------------------
// History / Balance / Summary
// ---------------------------------------------------------------------------

export async function sendPettyHistory(ctx: BotContext): Promise<void> {
  const rows = await callRpc<Array<{ display_id: string; transaction_at: string; type: string; amount: number; remark: string; running_balance: number }>>(
    "search_petty", { p_user_id: ctx.appUser.id, p_keyword: "", p_limit: 10, p_offset: 0 },
  );

  if (!rows || rows.length === 0) {
    await sendMessage(ctx.chatId, "No Petty Cash entries yet.");
    return;
  }

  const lines = rows.map((r) => `${r.display_id} | ${r.type} ${r.amount.toFixed(2)} | Bal: ${r.running_balance.toFixed(2)} | ${r.remark}`);
  await sendMessage(ctx.chatId, lines.join("\n"));
}

export async function sendPettyBalance(ctx: BotContext): Promise<void> {
  const currentCash = await callRpc<number>("current_petty_cash_balance", { p_user_id: ctx.appUser.id });
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "petty_summary", {
    period: "Lifetime", cashIn: "-", expense: "-", balance: "-", currentCash: currentCash.toFixed(2),
  }));
}

export async function sendPettyReportMenu(ctx: BotContext): Promise<void> {
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "export_choose_period"), {
    replyMarkup: datePresetsKeyboard(ctx.appUser.language, "PETTY_REPORT"),
  });
}

export async function sendPettyReportForPreset(ctx: BotContext, preset: DatePresetKey): Promise<void> {
  const { start, end } = resolveDatePreset(preset, ctx.appUser.timezone);
  const summary = await callRpc<{ cash_in: number; expense: number; period_balance: number; current_cash: number }>(
    "petty_cash_summary", { p_user_id: ctx.appUser.id, p_start: start.toISOString(), p_end: end.toISOString() },
  );

  await sendMessage(ctx.chatId, t(ctx.appUser.language, "petty_summary", {
    period: labelForPreset(preset, ctx.appUser.language), cashIn: summary.cash_in.toFixed(2), expense: summary.expense.toFixed(2),
    balance: summary.period_balance.toFixed(2), currentCash: summary.current_cash.toFixed(2),
  }));
}
