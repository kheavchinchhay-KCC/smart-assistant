// supabase/functions/telegram-webhook/index.ts
//
// Single HTTP entrypoint for the Telegram bot. Configure with:
//   telegram setWebhook url=<function URL> secret_token=<TELEGRAM_WEBHOOK_SECRET>
// See README "Telegram bot setup" for the exact commands.
//
// This file is the router only — all actual behavior lives in the
// sibling modules (sales.ts, pettycash.ts, ocr.ts, export.ts), each of
// which maps back to one or more legacy .gs files (see FEATURE_MATRIX.md).

import { verifyWebhookSecret } from "../_shared/telegramAuth.ts";
import { callRpc } from "../_shared/supabaseAdmin.ts";
import { sendMessage, editMessageText, answerCallbackQuery } from "./telegram.ts";
import { STRINGS, t, type Lang } from "./i18n.ts";
import {
  languageKeyboard, openSystemKeyboard, mainMenuReplyKeyboard, pettyCashMenuKeyboard,
  pettyMissingTypeKeyboard, saleMenuKeyboard, reportsChoiceKeyboard,
} from "./keyboards.ts";
import { resolveContext, getState, clearState, getRawAppUser } from "./db.ts";
import type { TgUpdate, BotContext } from "./types.ts";
import type { DatePresetKey } from "./parsers.ts";

import * as Sales from "./sales.ts";
import * as Petty from "./pettycash.ts";
import * as Ocr from "./ocr.ts";
import * as Exp from "./export.ts";

const WEBHOOK_SECRET = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")?.trim() ?? "";
const FRONTEND_URL = Deno.env.get("TELEGRAM_MINI_APP_URL")?.trim() ?? "";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("ok", { status: 200 });
  }

  // Fail closed: an unset webhook secret must never turn the public function
  // URL into an unauthenticated Telegram command endpoint.
  if (!WEBHOOK_SECRET) {
    console.error("TELEGRAM_WEBHOOK_SECRET not configured");
    return new Response("server misconfigured", { status: 500 });
  }
  if (!verifyWebhookSecret(req, WEBHOOK_SECRET)) {
    return new Response("forbidden", { status: 403 });
  }

  let update: TgUpdate;
  try {
    update = await req.json();
  } catch {
    return new Response("bad request", { status: 400 });
  }

  // Always 200 back to Telegram quickly-ish, even on internal errors,
  // so Telegram doesn't retry-storm us. Errors are logged, not thrown.
  try {
    if (update.callback_query) {
      await handleCallbackQuery(update);
    } else if (update.message) {
      await handleMessage(update);
    }
  } catch (e) {
    console.error("Unhandled webhook error:", e);
  }

  return new Response("ok", { status: 200 });
});

// ---------------------------------------------------------------------------
// /start and access control (spec §37)
// ---------------------------------------------------------------------------

async function handleStart(chatId: number, tgUser: NonNullable<TgUpdate["message"]>["from"]): Promise<void> {
  if (!tgUser) return;

  const raw = await getRawAppUser(tgUser.id);
  const lang: Lang = raw?.language ?? "en";

  if (!raw) {
    await sendMessage(chatId, t(lang, "access_denied", { status: "NOT_REGISTERED" }));
    return;
  }

  const ctx = await resolveContext(chatId, tgUser);
  if (!ctx) {
    await sendMessage(chatId, t(lang, "access_denied", { status: raw.status }));
    return;
  }

  await sendMessage(ctx.chatId, t(lang, "welcome", { name: ctx.appUser.display_name || tgUser.first_name, telegramId: ctx.telegramId }));
  await sendMessage(ctx.chatId, t(lang, "choose_language"), { replyMarkup: languageKeyboard() });

  if (FRONTEND_URL) {
    await sendMessage(ctx.chatId, t(lang, "open_system"), { replyMarkup: openSystemKeyboard(lang, FRONTEND_URL) });
  }

  await sendMainMenu(ctx);
}

async function sendMainMenu(ctx: BotContext): Promise<void> {
  await sendMessage(ctx.chatId, t(ctx.appUser.language, "main_menu_title"), {
    replyMarkup: mainMenuReplyKeyboard(ctx.appUser.language),
  });
}

// ---------------------------------------------------------------------------
// Message router (text + photo)
// ---------------------------------------------------------------------------

async function handleMessage(update: TgUpdate): Promise<void> {
  const message = update.message!;
  const chatId = message.chat.id;
  const tgUser = message.from;
  if (!tgUser) return;

  if (message.text === "/start") {
    await handleStart(chatId, tgUser);
    return;
  }

  const ctx = await resolveContext(chatId, tgUser);
  if (!ctx) {
    const raw = await getRawAppUser(tgUser.id);
    await sendMessage(chatId, t(raw?.language ?? "en", "access_denied", { status: raw?.status ?? "NOT_REGISTERED" }));
    return;
  }

  if (message.text === "/menu") {
    await clearState(chatId);
    await sendMainMenu(ctx);
    return;
  }

  if (message.photo && message.photo.length > 0) {
    // Telegram sends multiple resolutions; the last entry is the largest.
    const largest = message.photo[message.photo.length - 1];
    await Ocr.handleIncomingPhoto(ctx, largest.file_id);
    return;
  }

  const text = message.text ?? "";
  const lang = ctx.appUser.language;

  // Reply-keyboard main menu buttons (match either language, in case the
  // client still has a stale keyboard cached after a language switch).
  if (isButton(text, "btn_sale")) {
    await sendMessage(chatId, t(lang, "btn_sale"), { replyMarkup: saleMenuKeyboard(lang) });
    return;
  }
  if (isButton(text, "btn_petty_cash")) {
    await sendMessage(chatId, t(lang, "btn_petty_cash"), { replyMarkup: pettyCashMenuKeyboard(lang) });
    return;
  }
  if (isButton(text, "btn_reports")) {
    await sendMessage(chatId, t(lang, "btn_reports"), { replyMarkup: reportsChoiceKeyboard(lang) });
    return;
  }
  if (isButton(text, "btn_export")) {
    await Exp.startExportFlow(ctx);
    return;
  }

  const state = await getState(chatId);

  if (state.startsWith("missing_sale_")) {
    await Sales.handleMissingSaleStep(ctx, state, text);
    return;
  }
  if (state === "sale_delete_trxid") {
    await Sales.handleDeleteSaleTrxIdInput(ctx, text);
    return;
  }
  if (state === "petty_immediate_amount") {
    await Petty.handlePettyImmediateAmountStep(ctx, text);
    return;
  }
  if (state.startsWith("petty_missing_")) {
    await Petty.handleMissingPettyStep(ctx, state, text);
    return;
  }
  if (state === "petty_edit_id") {
    await Petty.handleEditPettyIdStep(ctx, text);
    return;
  }
  if (state === "petty_edit_amount") {
    await Petty.handleEditPettyAmountStep(ctx, text);
    return;
  }
  if (state === "petty_delete_id") {
    await Petty.handleDeletePettyIdStep(ctx, text);
    return;
  }

  // No active state and not a menu button: try parsing as a forwarded
  // bank notification (legacy Transaction.gs default behavior).
  const consumed = await Sales.tryHandleBankText(ctx, text);
  if (!consumed) {
    await sendMainMenu(ctx);
  }
}

function isButton(text: string, key: string): boolean {
  return text === STRINGS.en[key] || text === STRINGS.kh[key];
}

// ---------------------------------------------------------------------------
// Callback query router
// ---------------------------------------------------------------------------

async function handleCallbackQuery(update: TgUpdate): Promise<void> {
  const cq = update.callback_query!;
  const data = cq.data ?? "";
  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) return;

  await answerCallbackQuery(cq.id);

  // LANG:xx works even before full context resolution isn't needed here
  // since language selection only ever follows a successful /start.
  const ctx = await resolveContext(chatId, cq.from);
  if (!ctx) return;

  const lang = ctx.appUser.language;
  const [ns, action, arg] = data.split(":");

  if (ns === "LANG") {
    const newLang = action as Lang;
    await callRpc("update_own_profile", { p_user_id: ctx.appUser.id, p_language: newLang });
    ctx.appUser.language = newLang;
    await editMessageText(chatId, messageId, t(newLang, "choose_language"));
    await sendMainMenu(ctx);
    return;
  }

  if (ns === "MENU" && action === "MAIN") {
    await clearState(chatId);
    await sendMainMenu(ctx);
    return;
  }

  if (ns === "REPORTS") {
    if (action === "SALE") return void await Sales.sendSaleReportMenu(ctx);
    if (action === "PETTY") return void await Petty.sendPettyReportMenu(ctx);
  }

  if (ns === "SALE") {
    if (action === "MISSING") return void await Sales.startMissingSaleFlow(ctx);
    if (action === "DELETE" && !arg) return void await Sales.startDeleteSaleFlow(ctx);
    if (action === "DELETE" && arg === "CONFIRM") return void await Sales.confirmDeleteSale(ctx);
    if (action === "DELETE" && arg === "CANCEL") {
      await clearState(chatId);
      await editMessageText(chatId, messageId, t(lang, "btn_cancel"));
      return;
    }
  }

  if (ns === "SALE_REPORT") {
    return void await Sales.sendSaleReportForPreset(ctx, action as DatePresetKey);
  }

  if (ns === "MISSING_SALE_CCY") {
    return void await Sales.handleMissingSaleCurrencyChoice(ctx, action as "USD" | "KHR");
  }

  if (ns === "PC") {
    if (action === "IN") return void await Petty.startCashInOrExpense(ctx, "IN");
    if (action === "OUT") return void await Petty.startCashInOrExpense(ctx, "OUT");
    if (action === "MISSING" && !arg) {
      await editMessageText(chatId, messageId, t(lang, "btn_missing_petty"));
      await sendMessage(chatId, t(lang, "btn_missing_petty"), { replyMarkup: pettyMissingTypeKeyboard(lang) });
      return;
    }
    if (action === "MISSING" && arg === "IN") return void await Petty.startMissingPettyFlow(ctx, "IN");
    if (action === "MISSING" && arg === "OUT") return void await Petty.startMissingPettyFlow(ctx, "OUT");
    if (action === "HISTORY") return void await Petty.sendPettyHistory(ctx);
    if (action === "BALANCE") return void await Petty.sendPettyBalance(ctx);
    if (action === "REPORT") return void await Petty.sendPettyReportMenu(ctx);
    if (action === "EDIT") return void await Petty.startEditPettyFlow(ctx);
    if (action === "DELETE" && !arg) return void await Petty.startDeletePettyFlow(ctx);
    if (action === "DELETE" && arg === "CONFIRM") return void await Petty.confirmDeletePetty(ctx);
    if (action === "DELETE" && arg === "CANCEL") {
      await clearState(chatId);
      await editMessageText(chatId, messageId, t(lang, "btn_cancel"));
      return;
    }
  }

  if (ns === "PETTY_REPORT") {
    return void await Petty.sendPettyReportForPreset(ctx, action as DatePresetKey);
  }

  if (ns === "EXPORT") {
    if (action === "DATA") return void await Exp.handleExportDataChoice(ctx, arg as "sale" | "petty_cash");
    if (action === "FORMAT" && (arg === "xlsx" || arg === "pdf")) return void await Exp.handleExportFormatChoice(ctx, arg);
  }

  if (ns === "EXPORT_PERIOD") {
    return void await Exp.handleExportPeriodChoice(ctx, action as DatePresetKey);
  }

  if (ns === "SQ") {
    // data shape: "SQ:SE:<uuid>" | "SQ:SS:<uuid>" | "SQ:R:<uuid>" | "SQ:C:<uuid>"
    // uuid itself contains hyphens, so re-join everything after the 2nd colon.
    const jobId = data.split(":").slice(2).join(":");
    if (action === "SE") return void await Ocr.handleSaveAsExpense(ctx, jobId, messageId);
    if (action === "SS") return void await Ocr.handleSaveAsSale(ctx, jobId, messageId);
    if (action === "R") return void await Ocr.handleRetry(ctx, jobId, messageId);
    if (action === "C") return void await Ocr.handleCancel(ctx, jobId, messageId);
  }
}
