// Browser Telegram OIDC callback backend.
// Exchanges an authorization code with PKCE, verifies Telegram's RS256 ID
// token against the official JWKS, checks app_users, and mints the same
// application session used by the Mini App.

import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { callRpc } from "../_shared/supabaseAdmin.ts";
import { mintSessionToken } from "../_shared/session.ts";

interface AppUserRow {
  id: string;
  telegram_id: number;
  display_name: string;
  role: "ADMIN" | "USER";
  language: "en" | "kh";
  timezone: string;
  starts_at: string;
  expires_at: string | null;
}

interface Jwk {
  kty: string;
  n: string;
  e: string;
  alg?: string;
  kid?: string;
}

interface TelegramClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
}

function base64UrlToBytes(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlToJson<T>(value: string): T {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(value))) as T;
}

async function importRsaKey(jwk: Jwk): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "jwk",
    jwk as JsonWebKey,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
}

async function verifyTelegramIdToken(idToken: string, clientId: string, expectedNonce: string): Promise<TelegramClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("OIDC token malformed");

  const header = base64UrlToJson<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("OIDC token algorithm/key mismatch");

  const jwksResponse = await fetch("https://oauth.telegram.org/.well-known/jwks.json", { cache: "no-store" });
  if (!jwksResponse.ok) throw new Error("Unable to fetch Telegram signing keys");
  const jwks = await jwksResponse.json() as { keys?: Jwk[] };
  const jwk = jwks.keys?.find((key) => key.kid === header.kid && key.kty === "RSA");
  if (!jwk) throw new Error("Telegram signing key not found");

  const key = await importRsaKey(jwk);
  const verified = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" },
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!verified) throw new Error("OIDC signature invalid");

  const claims = base64UrlToJson<TelegramClaims>(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const audienceOk = Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId;

  if (claims.iss !== "https://oauth.telegram.org") throw new Error("OIDC issuer invalid");
  if (!audienceOk) throw new Error("OIDC audience invalid");
  if (!claims.sub) throw new Error("OIDC subject missing");
  if (!claims.exp || claims.exp <= now) throw new Error("OIDC token expired");
  if (claims.iat && claims.iat > now + 60) throw new Error("OIDC token issued in the future");
  if (claims.nonce !== expectedNonce) throw new Error("OIDC nonce mismatch");

  return claims;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;

  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  const clientId = (Deno.env.get("TELEGRAM_LOGIN_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("TELEGRAM_LOGIN_CLIENT_SECRET") ?? "").trim();
  const frontendOrigin = (Deno.env.get("FRONTEND_ORIGIN") ?? "").trim().replace(/\/$/, "");

  if (!clientId || !clientSecret || !frontendOrigin) {
    console.error("Web login server configuration missing");
    return errorResponse("Server misconfigured", 500);
  }

  const redirectUri = `${frontendOrigin}/auth/callback`;

  let body: { code?: string; codeVerifier?: string; nonce?: string };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body.code || !body.codeVerifier || !body.nonce) {
    return errorResponse("Login parameters are required", 400);
  }

  try {
    const credentials = btoa(`${clientId}:${clientSecret}`);
    const tokenResponse = await fetch("https://oauth.telegram.org/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${credentials}`,
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: body.code,
        redirect_uri: redirectUri,
        client_id: clientId,
        code_verifier: body.codeVerifier,
      }),
    });

    const tokenBody = await tokenResponse.json().catch(() => ({}));
    if (!tokenResponse.ok || typeof tokenBody.id_token !== "string") {
      console.error("Telegram OIDC token exchange failed", tokenResponse.status, tokenBody?.error ?? "unknown_error");
      return errorResponse("Telegram login could not be completed", 401);
    }

    const claims = await verifyTelegramIdToken(tokenBody.id_token, clientId, body.nonce);
    const telegramId = claims.sub?.trim() ?? "";
    if (!/^\d+$/.test(telegramId) || BigInt(telegramId) <= 0n) {
      return errorResponse("Telegram identity is invalid", 401);
    }

    const appUser = await callRpc<AppUserRow>("require_active_user", { p_telegram_id: telegramId });
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
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    console.error("Telegram web login failed", message);
    if (/access_denied|not registered|not currently valid/i.test(message)) {
      return errorResponse("This Telegram account is not registered or is not currently active. Please contact your administrator.", 403);
    }
    if (/OIDC|Telegram signing|token|issuer|audience|nonce|subject|identity/i.test(message)) {
      return errorResponse("Telegram login could not be verified", 401);
    }
    return errorResponse("Telegram login failed", 401);
  }
});
