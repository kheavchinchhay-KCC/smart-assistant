// frontend/src/lib/api.ts
//
// Thin client for the two Edge Functions this app talks to. No
// supabase-js dependency needed — every protected operation goes
// through `api`, authenticated with the session token from
// `auth-telegram-miniapp` (see README "Security Model" for why).

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string;
const PUBLIC_KEY = (import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY || import.meta.env.VITE_SUPABASE_ANON_KEY) as string;

const SESSION_STORAGE_KEY = "smart_assistant_session_v1";

export interface SessionUser {
  id: string;
  display_name: string;
  role: "ADMIN" | "USER";
  language: "en" | "kh";
  timezone: string;
  starts_at: string;
  expires_at: string | null;
}

interface StoredSession {
  token: string;
  user: SessionUser;
}

export function getStoredSession(): StoredSession | null {
  const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeSession(session: StoredSession) {
  sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_STORAGE_KEY);
}

/**
 * Step 3-9 of spec §16: sends Telegram's raw initData to the backend for
 * server-side HMAC validation, gets back a session token + user profile.
 * Throws on any failure (unregistered/inactive/expired user, or bad
 * initData) — caller shows an access-denied screen.
 */
export async function authenticateWithTelegram(initData: string): Promise<StoredSession> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-telegram-miniapp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      // The anon key here only satisfies the Supabase Edge Function
      // gateway's own JWT check — it is unrelated to this app's actual
      // identity model, which is Telegram-based (see README).
      Authorization: `Bearer ${PUBLIC_KEY}`,
    },
    body: JSON.stringify({ initData }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body?.error?.message ?? "Authentication failed");
  }

  const data = await res.json();
  const session: StoredSession = { token: data.token, user: data.user };
  storeSession(session);
  return session;
}


export async function authenticateWithTelegramWeb(
  code: string,
  codeVerifier: string,
  nonce: string,
): Promise<StoredSession> {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/auth-telegram-web`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PUBLIC_KEY}`,
    },
    body: JSON.stringify({ code, codeVerifier, nonce }),
  });

  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error?.message ?? "Telegram web login failed");
  }

  const session: StoredSession = { token: body.token, user: body.user };
  return session;
}

export class ApiError extends Error {
  code: string | null;
  status: number;
  constructor(message: string, code: string | null, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** Calls the consolidated `api` Edge Function with the current session token. */
export async function callApi<T = unknown>(action: string, payload: Record<string, unknown> = {}, retried = false): Promise<T> {
  let session = getStoredSession();
  if (!session) throw new ApiError("Not authenticated", "UNAUTHENTICATED", 401);

  const res = await fetch(`${SUPABASE_URL}/functions/v1/api`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.token}`,
    },
    body: JSON.stringify({ action, payload }),
  });

  if (res.status === 401 && !retried) {
    const tg = (window as any).Telegram?.WebApp;
    if (tg?.initData) {
      try {
        clearSession();
        session = await authenticateWithTelegram(tg.initData);
        return callApi<T>(action, payload, true);
      } catch {
        clearSession();
      }
    } else {
      clearSession();
    }
    throw new ApiError("Session expired", "UNAUTHENTICATED", 401);
  }

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(body?.error?.message ?? "Request failed", body?.error?.code ?? null, res.status);
  }

  return body as T;
}
