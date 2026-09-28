-- ============================================================================
-- 0001_extensions_and_helpers.sql
--
-- Purpose:
--   Base extensions + helper functions reused by every later migration.
--
-- Security model (documented once here, referenced everywhere else):
--   This project does NOT use Supabase Auth's email/password/OAuth users.
--   Identity comes from Telegram (validated server-side in the
--   `auth-telegram-miniapp` and `telegram-webhook` Edge Functions).
--
--   After validating a Telegram identity, the Edge Function mints a JWT
--   signed with the project's SUPABASE_JWT_SECRET (the same secret
--   PostgREST/GoTrue validates against). The JWT carries custom claims:
--     { role: "authenticated", app_user_id: "<uuid>", app_role: "ADMIN"|"USER", telegram_id: "<id>" }
--   The frontend then calls Supabase (PostgREST / supabase-js) directly
--   using that JWT as the bearer token for ordinary reads/writes, and Row
--   Level Security (enabled on every table in 0011) enforces isolation
--   using `auth.jwt() ->> 'app_user_id'` — NOT auth.uid()/auth.users.
--
--   Edge Functions that need elevated access (OCR/Gemini calls, exports,
--   Telegram webhook writes on behalf of a chat, admin user management)
--   use the SUPABASE_SERVICE_ROLE_KEY server-side only, and are
--   responsible for deriving the user id from the *validated* Telegram
--   update / session — never from a client-supplied field.
-- ============================================================================

create extension if not exists pgcrypto;      -- gen_random_uuid()
create extension if not exists pg_trgm;       -- fuzzy/ILIKE search indexes
create extension if not exists unaccent;      -- optional: fuzzier name search

-- ----------------------------------------------------------------------------
-- updated_at auto-touch trigger, used by every table below
-- ----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- JWT claim helpers for RLS policies.
-- These read custom claims from the JWT minted by our own Edge Functions
-- (see security model note above). They are STABLE, not SECURITY DEFINER,
-- and safe to use inside RLS USING/WITH CHECK clauses.
-- ----------------------------------------------------------------------------
create or replace function public.jwt_app_user_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'app_user_id', '')::uuid
$$;

create or replace function public.jwt_app_role()
returns text
language sql
stable
as $$
  select current_setting('request.jwt.claims', true)::jsonb ->> 'app_role'
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
as $$
  select coalesce(public.jwt_app_role() = 'ADMIN', false)
$$;

-- Normalizes a free-typed transaction/reference id for duplicate-safe
-- comparison: trims, collapses internal whitespace, uppercases.
-- Deliberately does NOT strip punctuation/leading zeros — spec section 5
-- warns against "accidentally merging genuinely different IDs".
create or replace function public.normalize_reference(p_ref text)
returns text
language sql
immutable
as $$
  select nullif(upper(regexp_replace(trim(coalesce(p_ref, '')), '\s+', ' ', 'g')), '')
$$;
