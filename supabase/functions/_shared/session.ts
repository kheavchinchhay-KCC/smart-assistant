// supabase/functions/_shared/session.ts
//
// This project does not use Supabase Auth (no email/password/OAuth users).
// Identity comes from Telegram and is validated server-side. After validation,
// the auth function mints a short-lived application session token signed with
// APP_SESSION_SECRET. The API function verifies that token itself and then
// re-validates the corresponding app_users row on every request.
//
// The API deliberately disables Supabase's gateway `verify_jwt` check because
// this session token is an application token, not a Supabase Auth JWT. This
// keeps the app independent of Supabase's legacy JWT secret / signing-key
// rotation. Database access is performed by the server-side secret-key client
// and every business operation receives the authenticated app user id.
//
// APP_SESSION_SECRET must be set as an Edge Function secret in both
// `auth-telegram-miniapp` and `api`. It must NEVER be sent to the frontend.
// Generate it randomly (for example: `openssl rand -hex 32`).

import jwt from "npm:jsonwebtoken@9";

export interface SessionClaims {
  app_user_id: string;
  app_role: "ADMIN" | "USER";
  telegram_id: number;
  display_name: string;
  language: "en" | "kh";
}

const SESSION_TTL_SECONDS = 60 * 60 * 12; // 12 hours; frontend re-auths via initData on expiry

export function mintSessionToken(claims: SessionClaims): string {
  const secret = requireSecret();

  return jwt.sign(
    {
      role: "authenticated", // retained for compatibility with the existing claim shape
      sub: claims.app_user_id,
      app_user_id: claims.app_user_id,
      app_role: claims.app_role,
      telegram_id: claims.telegram_id,
      display_name: claims.display_name,
      language: claims.language,
    },
    secret,
    { expiresIn: SESSION_TTL_SECONDS, algorithm: "HS256" },
  );
}

export function verifySessionToken(token: string): SessionClaims & { exp: number } {
  const secret = requireSecret();
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  // deno-lint-ignore no-explicit-any
  return decoded as any;
}

function requireSecret(): string {
  const secret = Deno.env.get("APP_SESSION_SECRET");
  if (!secret) {
    throw new Error("Missing APP_SESSION_SECRET in Edge Function environment");
  }
  return secret;
}
