// supabase/functions/auth-telegram-miniapp/index.ts
//
// POST { initData: string } -> { token, user } | 401/403
//
// Implements spec §16 steps 4-9:
//   4. Frontend sends raw initData here.
//   5. We validate it server-side (HMAC, see _shared/telegramAuth.ts).
//   6. Extract Telegram user id.
//   7. Check the app_users table (require_active_user RPC).
//   8. Check active/date validity (same RPC — raises if not valid).
//   9. Mint a short-lived signed session (see _shared/session.ts).
// Step 10 (frontend loads the user's own data) happens after this,
// using the returned token as the bearer for Supabase calls.

import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { validateInitData } from "../_shared/telegramAuth.ts";
import { callRpc } from "../_shared/supabaseAdmin.ts";
import { mintSessionToken } from "../_shared/session.ts";

interface AppUserRow {
  id: string;
  telegram_id: number;
  display_name: string;
  role: "ADMIN" | "USER";
  status: string;
  language: "en" | "kh";
  timezone: string;
  starts_at: string;
  expires_at: string | null;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  const botToken = Deno.env.get("TELEGRAM_BOT_TOKEN");
  if (!botToken) {
    console.error("TELEGRAM_BOT_TOKEN not configured");
    return errorResponse("Server misconfigured", 500);
  }

  let body: { initData?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.initData) {
    return errorResponse("initData is required", 400);
  }

  const result = await validateInitData(body.initData, botToken);
  if (!result.ok || !result.user) {
    // Never leak *why* validation failed beyond a generic reason —
    // avoids giving an attacker a signal about which check to work around.
    return errorResponse("Telegram authentication failed", 401);
  }

  const telegramId = result.user.id;

  let appUser: AppUserRow;
  try {
    appUser = await callRpc<AppUserRow>("require_active_user", { p_telegram_id: telegramId });
  } catch (_e) {
    // require_active_user raises for: not registered, inactive, blocked,
    // expired, or future start date. Spec §66 requires each of these to
    // be blocked; we don't need to distinguish them to the client beyond
    // a friendly message (the bot's /start already explains status).
    return errorResponse(
      "This Telegram account is not registered or is not currently active. Please contact your administrator.",
      403,
    );
  }

  await callRpc("record_user_login", { p_telegram_id: telegramId });

  const token = mintSessionToken({
    app_user_id: appUser.id,
    app_role: appUser.role,
    telegram_id: appUser.telegram_id,
    display_name: appUser.display_name,
    language: appUser.language,
  });

  return jsonResponse({
    token,
    user: {
      id: appUser.id,
      display_name: appUser.display_name,
      role: appUser.role,
      language: appUser.language,
      timezone: appUser.timezone,
      starts_at: appUser.starts_at,
      expires_at: appUser.expires_at,
    },
  });
});
