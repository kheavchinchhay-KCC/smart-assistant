// supabase/functions/telegram-webhook/db.ts
// Wraps the bot_* SQL functions from 0003_bot_sessions.sql, and resolves
// a full BotContext (app_users row) for an incoming Telegram user via
// require_active_user (0002_app_users.sql) — the single access gate
// shared with the frontend's auth-telegram-miniapp function.

import { callRpc, getAdminClient } from "../_shared/supabaseAdmin.ts";
import type { BotContext, TgUser } from "./types.ts";

/**
 * Raw lookup (bypassing require_active_user's validity check) used only
 * to render a helpful /start message for a user who exists but isn't
 * currently valid (spec §37: "If blocked/inactive/expired: show clear
 * access-denied message"). Service-role client bypasses RLS by design
 * (see 0011 note) — this file never runs anywhere but the webhook.
 */
export async function getRawAppUser(telegramId: number): Promise<{ language: "en" | "kh"; status: string } | null> {
  const { data } = await getAdminClient()
    .from("app_users")
    .select("language, status, starts_at, expires_at")
    .eq("telegram_id", telegramId)
    .maybeSingle();
  return data ?? null;
}

export async function resolveContext(chatId: number, tgUser: TgUser): Promise<BotContext | null> {
  try {
    const appUser = await callRpc<BotContext["appUser"]>("require_active_user", {
      p_telegram_id: tgUser.id,
    });
    return { chatId, telegramId: tgUser.id, tgUser, appUser };
  } catch {
    return null;
  }
}

export async function getState(chatId: number): Promise<string> {
  return await callRpc<string>("bot_get_state", { p_chat_id: chatId });
}

export async function setState(chatId: number, state: string): Promise<void> {
  await callRpc("bot_set_state", { p_chat_id: chatId, p_state: state });
}

export async function clearState(chatId: number): Promise<void> {
  await callRpc("bot_clear_state", { p_chat_id: chatId });
}

export async function getTemp(chatId: number, key: string): Promise<string | null> {
  return await callRpc<string | null>("bot_get_temp", { p_chat_id: chatId, p_key: key });
}

export async function setTemp(chatId: number, key: string, value: string): Promise<void> {
  await callRpc("bot_set_temp", { p_chat_id: chatId, p_key: key, p_value: value });
}

export async function clearTemp(chatId: number, key: string): Promise<void> {
  await callRpc("bot_clear_temp", { p_chat_id: chatId, p_key: key });
}

/** Convenience: read several temp keys at once. */
export async function getTempBatch(chatId: number, keys: string[]): Promise<Record<string, string | null>> {
  const entries = await Promise.all(keys.map(async (k) => [k, await getTemp(chatId, k)] as const));
  return Object.fromEntries(entries);
}

export async function clearTempBatch(chatId: number, keys: string[]): Promise<void> {
  await Promise.all(keys.map((k) => clearTemp(chatId, k)));
}
