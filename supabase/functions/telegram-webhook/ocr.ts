// supabase/functions/telegram-webhook/ocr.ts
// Ports SlipOCR.gs (Gemini call + field extraction) and SlipQueue.gs
// (the queue lifecycle + the Save-as-Sale/Save-as-Expense override
// buttons that are the whole point of spec §7).

import { getAdminClient, callRpc } from "../_shared/supabaseAdmin.ts";
import { downloadFile, sendMessage, editMessageText } from "./telegram.ts";
import { t } from "./i18n.ts";
import { slipQueueKeyboard } from "./keyboards.ts";
import { runOcrWithFallback } from "./gemini.ts";
import type { BotContext } from "./types.ts";

interface SlipJobRow {
  id: string;
  user_id: string;
  status: "READING" | "READY" | "FAILED" | "DUPLICATE" | "SAVED" | "CANCELLED";
  detected_type: "SALE_TRANSACTION" | "EXPENSE" | "UNKNOWN" | null;
  transaction_date: string | null;
  transaction_time: string | null;
  trx_id: string | null;
  original_amount: number | null;
  currency: string | null;
  holder: string | null;
  merchant: string | null;
  remark: string | null;
  error_message: string | null;
  storage_object_path: string | null;
}

export async function handleIncomingPhoto(ctx: BotContext, fileId: string): Promise<void> {
  const lang = ctx.appUser.language;
  const { bytes, mimeType } = await downloadFile(fileId);

  const now = new Date();
  const objectPath = `${ctx.appUser.id}/${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${crypto.randomUUID()}.jpg`;

  const { error: uploadError } = await getAdminClient().storage.from("slips").upload(objectPath, bytes, {
    contentType: mimeType, upsert: false,
  });
  if (uploadError) {
    console.error("Slip upload failed:", uploadError.message);
    await sendMessage(ctx.chatId, t(lang, "generic_error"));
    return;
  }

  const job = await callRpc<SlipJobRow>("create_slip_job", {
    p_user_id: ctx.appUser.id, p_telegram_chat_id: ctx.chatId, p_telegram_message_id: null,
    p_storage_object_path: objectPath, p_mime_type: mimeType, p_file_size_bytes: bytes.byteLength,
  });

  const readingMsg = await sendMessage(ctx.chatId, t(lang, "ocr_reading"));
  await getAdminClient().from("slip_jobs").update({ telegram_message_id: readingMsg.message_id }).eq("id", job.id);

  await runOcrAndRender(ctx, job.id, readingMsg.message_id, bytes, mimeType);
}

async function runOcrAndRender(ctx: BotContext, jobId: string, messageId: number, bytes: Uint8Array, mimeType: string): Promise<void> {
  const lang = ctx.appUser.language;

  const prefs = await callRpc<{ selected_gemini_model: string | null }>("get_or_create_preferences", { p_user_id: ctx.appUser.id });

  let job: SlipJobRow;
  try {
    const ocrResult = await runOcrWithFallback(ctx.appUser.id, bytes, mimeType, prefs.selected_gemini_model);
    job = await callRpc<SlipJobRow>("update_slip_job_from_ocr", {
      p_slip_job_id: jobId, p_is_bank_slip: ocrResult.isBankSlip, p_ocr_result: ocrResult.raw,
      p_ocr_model: ocrResult.modelUsed, p_ocr_key_ref_id: ocrResult.keyRefId,
    });
  } catch (e) {
    const message = (e as Error).message ?? "unknown error";
    console.error("OCR pipeline failed:", message);
    await getAdminClient().from("slip_jobs").update({ status: "FAILED", error_message: message.slice(0, 300) }).eq("id", jobId);
    await editMessageText(ctx.chatId, messageId, t(lang, "ocr_failed", { reason: friendlyOcrError(message) }), {
      replyMarkup: slipQueueKeyboard(lang, jobId, "FAILED"),
    });
    return;
  }

  await renderSlipJobMessage(ctx, job, messageId);
}

function friendlyOcrError(message: string): string {
  if (message.startsWith("NO_GEMINI_KEY")) return "No Gemini API key configured. Add one in Settings.";
  if (message.startsWith("ALL_KEYS_FAILED")) return "All configured Gemini keys failed. Check Settings -> Preferences -> Gemini.";
  return "Could not read this slip. Please try again.";
}

async function renderSlipJobMessage(ctx: BotContext, job: SlipJobRow, messageId: number): Promise<void> {
  const lang = ctx.appUser.language;

  if (job.status === "FAILED") {
    await editMessageText(ctx.chatId, messageId, t(lang, "ocr_failed", { reason: job.error_message ?? "" }), {
      replyMarkup: slipQueueKeyboard(lang, job.id, "FAILED"),
    });
    return;
  }

  if (job.status === "DUPLICATE") {
    await editMessageText(ctx.chatId, messageId, t(lang, "ocr_duplicate", { reason: job.error_message ?? "" }), {
      replyMarkup: slipQueueKeyboard(lang, job.id, "DUPLICATE"),
    });
    return;
  }

  // READY
  await editMessageText(
    ctx.chatId,
    messageId,
    t(lang, "ocr_ready", {
      detectedType: job.detected_type ?? "UNKNOWN",
      date: job.transaction_date ?? "-",
      time: job.transaction_time ?? "-",
      holder: job.holder ?? "-",
      amount: job.original_amount ?? 0,
      currency: job.currency ?? "",
      merchant: job.merchant ?? "-",
      remark: job.remark ?? "-",
      trxId: job.trx_id ?? "-",
    }),
    { replyMarkup: slipQueueKeyboard(lang, job.id, "READY") },
  );
}

// ---------------------------------------------------------------------------
// Callback query handlers for SQ:SE / SQ:SS / SQ:R / SQ:C (spec §53)
// ---------------------------------------------------------------------------

export async function handleSaveAsExpense(ctx: BotContext, jobId: string, messageId: number): Promise<void> {
  const lang = ctx.appUser.language;
  try {
    await callRpc("save_slip_as_expense", { p_slip_job_id: jobId, p_actor_user_id: ctx.appUser.id });
    await editMessageText(ctx.chatId, messageId, t(lang, "saved_as_expense"));
  } catch (e) {
    await handleSlipActionError(ctx, jobId, messageId, e as Error);
  }
}

export async function handleSaveAsSale(ctx: BotContext, jobId: string, messageId: number): Promise<void> {
  const lang = ctx.appUser.language;
  try {
    await callRpc("save_slip_as_sale", { p_slip_job_id: jobId, p_actor_user_id: ctx.appUser.id });
    await editMessageText(ctx.chatId, messageId, t(lang, "saved_as_sale"));
  } catch (e) {
    await handleSlipActionError(ctx, jobId, messageId, e as Error);
  }
}

async function handleSlipActionError(ctx: BotContext, jobId: string, messageId: number, e: Error): Promise<void> {
  const lang = ctx.appUser.language;
  const job = await callRpc<SlipJobRow>("retry_slip_job", { p_slip_job_id: jobId }).catch(() => null);
  const msg = e.message ?? "";

  if (msg.startsWith("DUPLICATE_REFERENCE")) {
    await editMessageText(ctx.chatId, messageId, t(lang, "ocr_duplicate", { reason: msg }), {
      replyMarkup: slipQueueKeyboard(lang, jobId, "DUPLICATE"),
    });
  } else {
    await editMessageText(ctx.chatId, messageId, t(lang, "ocr_failed", { reason: msg }), {
      replyMarkup: slipQueueKeyboard(lang, jobId, "FAILED"),
    });
  }
  void job;
}

export async function handleRetry(ctx: BotContext, jobId: string, messageId: number): Promise<void> {
  const lang = ctx.appUser.language;

  const { data: jobRow } = await getAdminClient().from("slip_jobs").select("*").eq("id", jobId).single();
  if (!jobRow || !jobRow.storage_object_path) {
    await editMessageText(ctx.chatId, messageId, t(lang, "generic_error"));
    return;
  }

  await callRpc("retry_slip_job", { p_slip_job_id: jobId });
  await editMessageText(ctx.chatId, messageId, t(lang, "ocr_reading"));

  const { data: fileData, error } = await getAdminClient().storage.from("slips").download(jobRow.storage_object_path);
  if (error || !fileData) {
    await editMessageText(ctx.chatId, messageId, t(lang, "generic_error"));
    return;
  }

  const bytes = new Uint8Array(await fileData.arrayBuffer());
  await runOcrAndRender(ctx, jobId, messageId, bytes, jobRow.mime_type ?? "image/jpeg");
}

export async function handleCancel(ctx: BotContext, jobId: string, messageId: number): Promise<void> {
  await callRpc("cancel_slip_job", { p_slip_job_id: jobId, p_actor_user_id: ctx.appUser.id });
  await editMessageText(ctx.chatId, messageId, t(ctx.appUser.language, "btn_cancel"));
}
