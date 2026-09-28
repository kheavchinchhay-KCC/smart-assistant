// supabase/functions/_shared/session.ts
//
// This project does not use Supabase Auth (no email/password, no OAuth
// users). Identity comes from Telegram. See the security-model comment
// at the top of migration 0001_extensions_and_helpers.sql for the full
// rationale — short version:
//
//   auth-telegram-miniapp validates Telegram's initData HMAC, resolves
//   an app_users row, and mints a JWT with this module, SIGNED WITH THE
//   SAME SECRET AS SUPABASE_JWT_SECRET. Because PostgREST/GoTrue trust
//   any JWT signed with that secret, our custom claims
//   (`app_user_id`, `app_role`) are readable inside Postgres via
//   `auth.jwt()`, which is exactly what the RLS policies in
//   0011_rls_policies.sql key off of.
//
// SUPABASE_JWT_SECRET must be set as an Edge Function secret. It is the
// same value shown in Supabase Dashboard -> Project Settings -> API ->
// JWT Settings -> JWT Secret. It must NEVER be sent to the frontend.

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
  const secret = Deno.env.get("SUPABASE_JWT_SECRET");
  if (!secret) {
    throw new Error("Missing SUPABASE_JWT_SECRET in Edge Function environment");
  }
  return secret;
}
