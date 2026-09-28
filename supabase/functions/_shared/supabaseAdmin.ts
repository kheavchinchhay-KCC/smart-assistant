// supabase/functions/_shared/supabaseAdmin.ts
//
// Every Edge Function in this project uses ONE shared way to talk to
// Postgres: the service-role client. See migration 0001/0011/0017 for
// why — all the SQL functions these Edge Functions call are granted to
// `service_role` only, and RLS is bypassed by service_role by design.
//
// This client must NEVER be constructed in frontend code. It only ever
// runs inside an Edge Function, using SUPABASE_SERVICE_ROLE_KEY from
// the function's own environment (set via `supabase secrets set`).
// Supabase is moving from legacy service_role keys to publishable/secret keys;
// Edge Functions should prefer SUPABASE_SECRET_KEY when configured. An optional
// SUPABASE_SECRET_KEYS JSON bundle is also accepted for deployments that manage
// multiple server keys; the legacy service-role name remains a compatibility fallback.

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

let cached: SupabaseClient | null = null;

function getServerKey(): string | null {
  const direct = Deno.env.get("SUPABASE_SECRET_KEY")?.trim();
  if (direct) return direct;

  const bundle = Deno.env.get("SUPABASE_SECRET_KEYS")?.trim();
  if (bundle) {
    try {
      const parsed = JSON.parse(bundle) as Record<string, unknown>;
      if (typeof parsed.default === "string" && parsed.default.trim()) return parsed.default.trim();
    } catch {
      throw new Error("SUPABASE_SECRET_KEYS must contain valid JSON with a non-empty `default` key");
    }
  }

  const legacy = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")?.trim();
  return legacy || null;
}

export function getAdminClient(): SupabaseClient {
  if (cached) return cached;

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = getServerKey();

  if (!url || !serviceKey) {
    throw new Error(
      "Missing SUPABASE_URL and a server secret key (SUPABASE_SECRET_KEY, SUPABASE_SECRET_KEYS.default, or legacy SUPABASE_SERVICE_ROLE_KEY)",
    );
  }

  cached = createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  return cached;
}

/**
 * Thin wrapper around .rpc() that throws a plain Error with the
 * Postgres error message on failure, so callers can just `await` and
 * `try/catch` without digging into { data, error }.
 */
export async function callRpc<T = unknown>(
  fn: string,
  args: Record<string, unknown>,
): Promise<T> {
  const { data, error } = await getAdminClient().rpc(fn, args);
  if (error) {
    const e = new Error(error.message);
    // deno-lint-ignore no-explicit-any
    (e as any).code = error.code;
    // deno-lint-ignore no-explicit-any
    (e as any).details = error.details;
    throw e;
  }
  return data as T;
}
