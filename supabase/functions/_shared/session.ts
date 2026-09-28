// supabase/functions/_shared/session.ts
//
// This project does not use Supabase Auth (no email/password, no OAuth
// users). Identity comes from Telegram. See the security-model comment
// at the top of migration 0001_extensions_and_helpers.sql for the full
// rationale — short version:
//
//   auth-telegram-miniapp validates Telegram's initData HMAC, resolves
//   an app_users row, and mints a JWT with this module, SIGNED WITH THE
//   SAME APP_SESSION_SECRET. The frontend talks only to our Edge API; the
//   custom token is verified by that function and is not a Supabase Auth JWT.
//   Elevated database work is performed with the server-only Supabase key.
//
// APP_SESSION_SECRET must be set as an Edge Function secret. Generate a
// strong random value and use the same value for the `api` and
// `auth-telegram-miniapp` Edge Functions. It must NEVER be sent to the frontend.

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
      role: "authenticated", // required so PostgREST treats this as an authenticated request
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
