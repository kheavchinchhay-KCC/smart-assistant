// Telegram OpenID Connect browser login (Authorization Code + PKCE).
// Browser-safe values only. The Client Secret stays in the Edge Function.

import { authenticateWithTelegramWeb, storeSession, type SessionUser } from "./api";

const TELEGRAM_LOGIN_CLIENT_ID =
  (import.meta.env.VITE_TELEGRAM_LOGIN_CLIENT_ID as string | undefined)?.trim() || "8822132059";
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const REDIRECT_URI = `${window.location.origin}/auth/callback`;

const STATE_KEY = "smart_assistant_oidc_state_v1";
const VERIFIER_KEY = "smart_assistant_oidc_verifier_v1";
const NONCE_KEY = "smart_assistant_oidc_nonce_v1";

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256Base64Url(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return toBase64Url(new Uint8Array(digest));
}

function randomToken(bytes = 32): string {
  return toBase64Url(randomBytes(bytes));
}

export async function startTelegramWebLogin(): Promise<void> {
  if (!SUPABASE_URL) throw new Error("Supabase URL is not configured");
  if (!TELEGRAM_LOGIN_CLIENT_ID) throw new Error("Telegram Login Client ID is not configured");

  const state = randomToken(32);
  const verifier = randomToken(48);
  const nonce = randomToken(24);
  const challenge = await sha256Base64Url(verifier);

  sessionStorage.setItem(STATE_KEY, state);
  sessionStorage.setItem(VERIFIER_KEY, verifier);
  sessionStorage.setItem(NONCE_KEY, nonce);

  const authUrl = new URL("https://oauth.telegram.org/auth");
  authUrl.searchParams.set("client_id", TELEGRAM_LOGIN_CLIENT_ID);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid profile");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("nonce", nonce);

  window.location.assign(authUrl.toString());
}

export async function completeTelegramWebLogin(search: string): Promise<{ user: SessionUser }> {
  const params = new URLSearchParams(search);
  const error = params.get("error");
  if (error) {
    throw new Error(params.get("error_description") || `Telegram login failed: ${error}`);
  }

  const code = params.get("code");
  const returnedState = params.get("state");
  const expectedState = sessionStorage.getItem(STATE_KEY);
  const verifier = sessionStorage.getItem(VERIFIER_KEY);
  const nonce = sessionStorage.getItem(NONCE_KEY);

  if (!code) throw new Error("Telegram did not return an authorization code");
  if (!returnedState || !expectedState || returnedState !== expectedState) {
    throw new Error("Telegram login state validation failed");
  }
  if (!verifier || !nonce) throw new Error("Telegram login session expired; please try again");

  const session = await authenticateWithTelegramWeb(code, verifier, nonce);
  storeSession(session);

  sessionStorage.removeItem(STATE_KEY);
  sessionStorage.removeItem(VERIFIER_KEY);
  sessionStorage.removeItem(NONCE_KEY);

  return { user: session.user };
}
