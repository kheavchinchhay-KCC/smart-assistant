// supabase/functions/_shared/telegramAuth.ts
//
// Two distinct trust boundaries, both required by spec §16/§61:
//
//  1. verifyWebhookSecret() — proves an incoming HTTP request to the
//     telegram-webhook function actually came from Telegram's servers
//     (Telegram sends back whatever secret_token you configured with
//     setWebhook, in the X-Telegram-Bot-Api-Secret-Token header).
//
//  2. validateInitData() — proves a `Telegram.WebApp.initData` string
//     handed to us by the frontend was genuinely produced by Telegram
//     for THIS bot, not forged by the browser. This is the full HMAC
//     check from Telegram's Mini Apps docs
//     (https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app).
//     `initDataUnsafe` (the pre-parsed, unverified JS object) must never
//     be trusted for identity — only the raw `initData` string run
//     through this function.

export interface TelegramWebAppUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface InitDataValidationResult {
  ok: boolean;
  user?: TelegramWebAppUser;
  authDate?: number;
  reason?: string;
}

async function hmacSha256(keyBytes: Uint8Array | ArrayBuffer, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message));
  return new Uint8Array(sig);
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Validates a Telegram Mini App `initData` string against the bot token.
 * Rejects data older than `maxAgeSeconds` (default 24h) to bound replay
 * risk, per spec §16/§17 ("short-lived signed application session").
 */
export async function validateInitData(
  initData: string,
  botToken: string,
  maxAgeSeconds = 86400,
): Promise<InitDataValidationResult> {
  if (!initData) return { ok: false, reason: "empty initData" };

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return { ok: false, reason: "missing hash" };
  params.delete("hash");

  const pairs: string[] = [];
  const sortedKeys = [...params.keys()].sort();
  for (const key of sortedKeys) {
    pairs.push(`${key}=${params.get(key)}`);
  }
  const dataCheckString = pairs.join("\n");

  const secretKey = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computedHashBytes = await hmacSha256(secretKey, dataCheckString);
  const computedHash = toHex(computedHashBytes);

  if (computedHash !== hash) {
    return { ok: false, reason: "hash mismatch" };
  }

  const authDateStr = params.get("auth_date");
  const authDate = authDateStr ? parseInt(authDateStr, 10) : 0;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!authDate) return { ok: false, reason: "missing auth_date" };
  if (authDate > nowSeconds + 300) return { ok: false, reason: "initData auth_date is in the future" };
  if (nowSeconds - authDate > maxAgeSeconds) return { ok: false, reason: "initData expired" };

  const userJson = params.get("user");
  if (!userJson) return { ok: false, reason: "missing user" };

  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(userJson);
  } catch {
    return { ok: false, reason: "malformed user JSON" };
  }

  if (!user.id) return { ok: false, reason: "missing telegram user id" };

  return { ok: true, user, authDate };
}

/** Verifies the X-Telegram-Bot-Api-Secret-Token header on webhook requests. */
export function verifyWebhookSecret(req: Request, expectedSecret: string): boolean {
  const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token");
  return !!header && header === expectedSecret;
}
