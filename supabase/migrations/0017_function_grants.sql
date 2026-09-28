-- ============================================================================
-- 0017_function_grants.sql
--
-- IMPORTANT: PostgreSQL grants EXECUTE on newly created functions to the
-- PUBLIC pseudo-role by default, and Supabase's `anon`/`authenticated`
-- roles inherit PUBLIC. Left alone, EVERY function created in the
-- migrations above (including admin_create_user, add_gemini_key,
-- get_gemini_key_plaintext!) would be callable by any signed-in client
-- via PostgREST's auto-exposed /rest/v1/rpc/<function> endpoint.
--
-- This migration is the actual enforcement of the security model
-- documented in 0001/0011: every one of these functions is meant to be
-- called ONLY from Edge Functions using the service role key, which have
-- already authenticated the caller from a validated Telegram identity or
-- session. We revoke PUBLIC execute on all of them and grant execute
-- back to `service_role` only.
--
-- Run this LAST, after every function in the schema has been created.
-- Any new function added later must get an explicit grant here (or in a
-- follow-up migration) — it is NOT safe to assume "not granted" by
-- default.
-- ============================================================================

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    execute format('revoke execute on function %s from public, anon, authenticated;', r.sig);
    execute format('grant execute on function %s to service_role;', r.sig);
  end loop;
end;
$$;

-- The blanket revoke above also caught the JWT-claim helper functions
-- from 0001 (jwt_app_user_id, jwt_app_role, is_admin) and the
-- normalize_reference helper. RLS policies (0011) call these directly
-- in their USING/WITH CHECK clauses, and a policy expression executes
-- AS the querying role — so anon/authenticated must be able to execute
-- these specific helpers, or every RLS-protected query fails with
-- "permission denied for function..." before RLS even gets to decide
-- allow/deny. These four are read-only, take no sensitive input, and
-- only ever return the caller's own JWT claims — safe to expose.
grant execute on function public.jwt_app_user_id() to anon, authenticated;
grant execute on function public.jwt_app_role() to anon, authenticated;
grant execute on function public.is_admin() to anon, authenticated;
grant execute on function public.normalize_reference(text) to anon, authenticated;

-- Table-level privileges: with RLS enabled (0011) and policies scoped to
-- jwt_app_user_id()/is_admin(), it is safe to also grant baseline
-- table access to 'authenticated' for the tables that have real
-- policies, in case a future feature calls PostgREST directly (see the
-- 0011 note). Tables with NO policies (audit_log, bot_sessions,
-- transaction_reference_registry, petty_cash_id_counters) are
-- deliberately left with no grants at all — RLS with zero policies
-- denies all access from anon/authenticated regardless of table grants,
-- but omitting the grant too is an extra belt-and-suspenders layer.
grant select on public.app_users to authenticated;
grant select, insert, update, delete on public.user_preferences to authenticated;
grant select on public.gemini_api_key_refs to authenticated;
grant select, insert, update, delete on public.sales to authenticated;
grant select, insert, update, delete on public.petty_cash_transactions to authenticated;
grant select on public.petty_cash_id_counters to authenticated;
grant select, insert, update, delete on public.slip_jobs to authenticated;
grant select on public.exports to authenticated;

-- service_role gets full table access unconditionally (Supabase default
-- behavior; stated here for clarity, not strictly required).
grant all on all tables in schema public to service_role;
