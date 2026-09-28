-- ============================================================================
-- 0011_rls_policies.sql
--
-- Architecture decision (also documented in README "Security Model"):
--   In this drop, EVERY client request — bot or web — is mediated by an
--   Edge Function running with the SUPABASE_SERVICE_ROLE_KEY. The Edge
--   Function is the only place that derives "who is calling" (from a
--   validated Telegram update, or from our custom-signed session JWT),
--   and it is the only thing that ever passes a user_id into a SQL
--   function — never a client-supplied field (spec §48).
--
--   service_role bypasses RLS entirely, by design, everywhere in
--   Supabase. So the policies below are a DEFENSE-IN-DEPTH backstop for
--   the 'authenticated' and 'anon' Postgres roles, in case:
--     (a) a future feature calls PostgREST directly with the
--         custom-signed JWT (see 0001 security model note) instead of
--         going through an Edge Function, or
--     (b) a bug ever exposes the anon/public key to a client for one of
--         these tables.
--   They are written as if that direct-access path were live today, so
--   turning it on later is safe without re-auditing RLS.
--
--   Every table in the schema has RLS enabled, per spec §18.
-- ============================================================================

alter table public.app_users enable row level security;
alter table public.user_preferences enable row level security;
alter table public.gemini_api_key_refs enable row level security;
alter table public.sales enable row level security;
alter table public.petty_cash_transactions enable row level security;
alter table public.petty_cash_id_counters enable row level security;
alter table public.slip_jobs enable row level security;
alter table public.exports enable row level security;
alter table public.audit_log enable row level security;
alter table public.transaction_reference_registry enable row level security;
alter table public.bot_sessions enable row level security;

-- ----------------------------------------------------------------------------
-- app_users: a user may read their own row; admins may read/manage all.
-- Row mutation for anything beyond a user's own language/timezone happens
-- through admin-only Edge Functions (createUser/activateUser/etc, §31),
-- not raw table UPDATE, so there is no "update own row" policy here.
-- ----------------------------------------------------------------------------
create policy app_users_select_own_or_admin on public.app_users
  for select
  using (id = public.jwt_app_user_id() or public.is_admin());

create policy app_users_admin_all on public.app_users
  for all
  using (public.is_admin())
  with check (public.is_admin());

-- ----------------------------------------------------------------------------
-- user_preferences, gemini_api_key_refs: strictly own-user. No admin
-- bypass — these are personal OCR/API-key settings, not shared config,
-- and spec §13 says admin does not get blanket access to user data
-- beyond what's explicitly listed (user management).
-- ----------------------------------------------------------------------------
create policy user_preferences_owner_only on public.user_preferences
  for all
  using (user_id = public.jwt_app_user_id())
  with check (user_id = public.jwt_app_user_id());

create policy gemini_api_key_refs_select_own on public.gemini_api_key_refs
  for select
  using (user_id = public.jwt_app_user_id());
-- Deliberately no insert/update/delete policy: key mutation always goes
-- through add_gemini_key()/remove_gemini_key() (SECURITY DEFINER,
-- service_role only — see 0016 grants), never a raw table write, so a
-- client can never set an arbitrary vault_secret_id.

-- ----------------------------------------------------------------------------
-- sales / petty_cash_transactions: strictly own-user, full CRUD (the
-- app layer enforces soft-delete via UPDATE ... SET deleted_at = now()).
-- No admin bypass (spec §13: transaction data stays user-scoped by
-- default, admin is not silently granted access to all financial data).
-- ----------------------------------------------------------------------------
create policy sales_owner_only on public.sales
  for all
  using (user_id = public.jwt_app_user_id())
  with check (user_id = public.jwt_app_user_id());

create policy petty_cash_owner_only on public.petty_cash_transactions
  for all
  using (user_id = public.jwt_app_user_id())
  with check (user_id = public.jwt_app_user_id());

create policy petty_cash_counters_owner_only on public.petty_cash_id_counters
  for select
  using (user_id = public.jwt_app_user_id());

-- ----------------------------------------------------------------------------
-- slip_jobs: own-user only.
-- ----------------------------------------------------------------------------
create policy slip_jobs_owner_only on public.slip_jobs
  for all
  using (user_id = public.jwt_app_user_id())
  with check (user_id = public.jwt_app_user_id());

-- ----------------------------------------------------------------------------
-- exports: own-user, read-only from the client's perspective (rows are
-- created by the export Edge Function using the service role).
-- ----------------------------------------------------------------------------
create policy exports_select_own on public.exports
  for select
  using (user_id = public.jwt_app_user_id());

-- ----------------------------------------------------------------------------
-- audit_log, transaction_reference_registry, bot_sessions: internal
-- bookkeeping only. No policies granted at all => every access from
-- anon/authenticated is denied by default once RLS is enabled; only
-- service_role (Edge Functions) can read/write them.
-- ----------------------------------------------------------------------------
-- (intentionally no policies for these three tables)

-- ----------------------------------------------------------------------------
-- Storage RLS: objects in "slips" and "exports" buckets are only
-- accessible to their owning user (folder-prefixed by user_id), or via
-- signed URLs issued server-side. Mirrors spec §11/§41.
-- ----------------------------------------------------------------------------
create policy slips_owner_only on storage.objects
  for select
  using (
    bucket_id = 'slips'
    and (storage.foldername(name))[1] = public.jwt_app_user_id()::text
  );

create policy exports_owner_only on storage.objects
  for select
  using (
    bucket_id = 'exports'
    and (storage.foldername(name))[1] = public.jwt_app_user_id()::text
  );
-- Inserts/updates/deletes on these buckets are performed exclusively by
-- Edge Functions with the service role key, which bypasses these
-- policies entirely, so no insert/update/delete policy is defined here.
