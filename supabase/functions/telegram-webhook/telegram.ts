// supabase/functions/telegram-webhook/telegram.ts
//
// Minimal Bot API client. Keeps the bot token server-side only (spec
// §61 "Keep Telegram Bot API calls server-side... Do not put bot token
// in the frontend"), and centralizes the fetch boilerplate.

import type { InlineKeyboard } from "./types.ts";

function getBotToken(): string {
  const token = Deno.env.get("TELEGRAM_BOT_TOKEN")?.trim() ?? "";
  if (!token) throw new Error("TELEGRAM_NOT_CONFIGURED: TELEGRAM_BOT_TOKEN is missing");
  return token;
}

async function call(method: string, payload: Record<string, unknown>): Promise<unknown> {
  const token = getBotToken();
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let json: { ok?: boolean; description?: unknown; result?: unknown };
  try {
    json = await res.json();
  } catch {
    throw new Error(`TELEGRAM_API_${method}: invalid JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || !json.ok) {
    const description = String(json.description ?? "Telegram API request failed");
    console.error(`Telegram API error on ${method}:`, description);
    throw new Error(`TELEGRAM_API_${method}: ${description}`);
  }
  return json.result;
}

export async function sendMessage(
  chatId: number,
  text: string,
  opts: { replyMarkup?: InlineKeyboard | { keyboard: string[][]; resize_keyboard?: boolean }; parseMode?: string } = {},
): Promise<{ message_id: number }> {
  const payload: Record<string, unknown> = { chat_id: chatId, text };
  if (opts.parseMode) payload.parse_mode = opts.parseMode;
  if (opts.replyMarkup) {
    payload.reply_markup = Array.isArray(opts.replyMarkup)
      ? { inline_keyboard: opts.replyMarkup }
      : opts.replyMarkup;
  }
  return (await call("sendMessage", payload)) as { message_id: number };
}

export async function editMessageText(
  chatId: number,
  messageId: number,
  text: string,
  opts: { replyMarkup?: InlineKeyboard } = {},
): Promise<unknown> {
  const payload: Record<string, unknown> = { chat_id: chatId, message_id: messageId, text };
  if (opts.replyMarkup) payload.reply_markup = { inline_keyboard: opts.replyMarkup };
  return await call("editMessageText", payload);
}

export async function editMessageReplyMarkup(
  chatId: number,
  messageId: number,
  keyboard: InlineKeyboard | null,
): Promise<unknown> {
  return await call("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
  });
}

export async function answerCallbackQuery(
  callbackQueryId: string,
  text?: string,
  showAlert = false,
): Promise<unknown> {
  return await call("answerCallbackQuery", { callback_query_id: callbackQueryId, text, show_alert: showAlert });
}

export async function sendDocument(
  chatId: number,
  fileUrl: string,
  caption?: string,
): Promise<unknown> {
  return await call("sendDocument", { chat_id: chatId, document: fileUrl, caption });
}

export async function getFileUrl(fileId: string): Promise<string> {
  const res = await call("getFile", { file_id: fileId }) as { file_path: string };
  return `https://api.telegram.org/file/bot${getBotToken()}/${res.file_path}`;
}

export async function downloadFile(fileId: string): Promise<{ bytes: Uint8Array; mimeType: string }> {
  const url = await getFileUrl(fileId);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`TELEGRAM_FILE_HTTP_${res.status}: failed to download file`);
  const buf = new Uint8Array(await res.arrayBuffer());
  const mimeType = res.headers.get("content-type") ?? "image/jpeg";
  return { bytes: buf, mimeType };
}
