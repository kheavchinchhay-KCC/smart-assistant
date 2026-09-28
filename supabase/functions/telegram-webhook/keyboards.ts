// supabase/functions/telegram-webhook/keyboards.ts
// Ported from legacy Keyboard.gs, generalized for i18n (spec §59) and
// restructured callback_data per spec §53 ("short stable callback
// formats"). A uuid slip job id is 36 chars; "SQ:SE:" + uuid = 42 bytes,
// comfortably under Telegram's 64-byte callback_data limit, so no extra
// id-shortening table is needed.

import { t, type Lang } from "./i18n.ts";
import type { InlineKeyboard } from "./types.ts";

export function languageKeyboard(): InlineKeyboard {
  return [[
    { text: "🇬🇧 EN", callback_data: "LANG:en" },
    { text: "🇰🇭 KH", callback_data: "LANG:kh" },
  ]];
}

export function openSystemKeyboard(lang: Lang, webAppUrl: string): InlineKeyboard {
  return [[{ text: t(lang, "open_system"), web_app: { url: webAppUrl } }]];
}

export function mainMenuReplyKeyboard(lang: Lang) {
  return {
    keyboard: [
      [t(lang, "btn_sale"), t(lang, "btn_petty_cash")],
      [t(lang, "btn_reports"), t(lang, "btn_export")],
    ],
    resize_keyboard: true,
  };
}

export function pettyCashMenuKeyboard(lang: Lang): InlineKeyboard {
  return [
    [{ text: t(lang, "btn_cash_in"), callback_data: "PC:IN" }, { text: t(lang, "btn_expense"), callback_data: "PC:OUT" }],
    [{ text: t(lang, "btn_missing_petty"), callback_data: "PC:MISSING" }],
    [{ text: t(lang, "btn_history"), callback_data: "PC:HISTORY" }, { text: t(lang, "btn_balance"), callback_data: "PC:BALANCE" }],
    [{ text: t(lang, "btn_reports"), callback_data: "PC:REPORT" }],
    [{ text: t(lang, "btn_edit"), callback_data: "PC:EDIT" }, { text: t(lang, "btn_delete"), callback_data: "PC:DELETE" }],
    [{ text: t(lang, "btn_back"), callback_data: "MENU:MAIN" }],
  ];
}

/** Sub-choice shown after "Add Missing" in Petty Cash — which type is backdated. */
export function pettyMissingTypeKeyboard(lang: Lang): InlineKeyboard {
  return [[
    { text: t(lang, "btn_cash_in"), callback_data: "PC:MISSING:IN" },
    { text: t(lang, "btn_expense"), callback_data: "PC:MISSING:OUT" },
  ]];
}

/** Top-level "Reports" menu button routes to either Sale or Petty reports. */
export function reportsChoiceKeyboard(lang: Lang): InlineKeyboard {
  return [
    [{ text: t(lang, "btn_sale"), callback_data: "REPORTS:SALE" }],
    [{ text: t(lang, "btn_petty_cash"), callback_data: "REPORTS:PETTY" }],
  ];
}

export function saleMenuKeyboard(lang: Lang): InlineKeyboard {
  return [
    [{ text: t(lang, "btn_missing_sale"), callback_data: "SALE:MISSING" }],
    [{ text: t(lang, "btn_delete"), callback_data: "SALE:DELETE" }],
    [{ text: t(lang, "btn_back"), callback_data: "MENU:MAIN" }],
  ];
}

/** Date presets shared by Reports/Export/Sale/Petty screens (spec §46). */
export function datePresetsKeyboard(lang: Lang, prefix: string): InlineKeyboard {
  return [
    [{ text: t(lang, "btn_today"), callback_data: `${prefix}:TODAY` }, { text: t(lang, "btn_yesterday"), callback_data: `${prefix}:YESTERDAY` }],
    [{ text: t(lang, "btn_this_week"), callback_data: `${prefix}:THIS_WEEK` }, { text: t(lang, "btn_last_week"), callback_data: `${prefix}:LAST_WEEK` }],
    [{ text: t(lang, "btn_this_month"), callback_data: `${prefix}:THIS_MONTH` }, { text: t(lang, "btn_last_month"), callback_data: `${prefix}:LAST_MONTH` }],
    [{ text: t(lang, "btn_custom_range"), callback_data: `${prefix}:CUSTOM` }],
  ];
}

export function currencyKeyboard(prefix: string): InlineKeyboard {
  return [[{ text: "USD", callback_data: `${prefix}:USD` }, { text: "KHR", callback_data: `${prefix}:KHR` }]];
}

export function confirmCancelKeyboard(lang: Lang, confirmData: string, cancelData: string): InlineKeyboard {
  return [[{ text: t(lang, "btn_confirm"), callback_data: confirmData }, { text: t(lang, "btn_cancel"), callback_data: cancelData }]];
}

export function exportDataKeyboard(lang: Lang): InlineKeyboard {
  return [
    [{ text: t(lang, "btn_sale"), callback_data: "EXPORT:DATA:sale" }],
    [{ text: t(lang, "btn_petty_cash"), callback_data: "EXPORT:DATA:petty_cash" }],
  ];
}

export function exportFormatKeyboard(lang: Lang): InlineKeyboard {
  return [[{ text: t(lang, "btn_excel"), callback_data: "EXPORT:FORMAT:xlsx" }, { text: t(lang, "btn_pdf"), callback_data: "EXPORT:FORMAT:pdf" }]];
}

/**
 * The spec §7/§53 four-button OCR override keyboard. Always shows BOTH
 * save destinations regardless of what Gemini detected — the whole
 * point is that detection is a suggestion, never a forced decision.
 */
export function slipQueueKeyboard(lang: Lang, jobId: string, status: "READY" | "FAILED" | "DUPLICATE"): InlineKeyboard {
  if (status === "READY") {
    return [
      [{ text: t(lang, "btn_save_as_expense"), callback_data: `SQ:SE:${jobId}` }],
      [{ text: t(lang, "btn_save_as_sale"), callback_data: `SQ:SS:${jobId}` }],
      [{ text: t(lang, "btn_retry"), callback_data: `SQ:R:${jobId}` }, { text: t(lang, "btn_cancel"), callback_data: `SQ:C:${jobId}` }],
    ];
  }
  // FAILED / DUPLICATE: only Retry/Cancel make sense.
  return [[{ text: t(lang, "btn_retry"), callback_data: `SQ:R:${jobId}` }, { text: t(lang, "btn_cancel"), callback_data: `SQ:C:${jobId}` }]];
}
