-- ============================================================================
-- 0005_gemini_api_key_refs.sql
--
-- Per-user Gemini API key storage (spec §9). The raw key value NEVER sits
-- in an ordinary table column. It is stored via Supabase Vault
-- (`vault.create_secret`), and this table only holds a reference
-- (`vault_secret_id`) plus non-secret metadata (label, masked last-4,
-- priority, enabled flag, test/usage status).
--
-- Only SECURITY DEFINER functions below may read the decrypted value
-- (via `vault.decrypted_secrets`), and they are only ever called from
-- Edge Functions using the service role key — never exposed to the
-- 'authenticated' role, so the frontend can never retrieve a raw key.
-- ============================================================================

create table public.gemini_api_key_refs (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references public.app_users(id) on delete cascade,
  label             text not null default 'Key',
  vault_secret_id   uuid not null,             -- references vault.secrets.id
  masked_last4      text not null default '',  -- e.g. "1234", for UI display as ••••••••1234
  enabled           boolean not null default true,
  priority          smallint not null default 100,   -- lower = tried first
  last_tested_at    timestamptz null,
  last_test_ok      boolean null,
  last_error        text null,
  last_used_at      timestamptz null,
  failure_count     integer not null default 0,
  cooldown_until    timestamptz null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create index gemini_api_key_refs_user_idx on public.gemini_api_key_refs (user_id, enabled, priority);

create trigger trg_gemini_api_key_refs_updated_at
  before update on public.gemini_api_key_refs
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- add_gemini_key: stores the raw key in Vault, keeps only a reference here.
-- Called only from a service-role Edge Function (never from the frontend
-- directly) so the raw key value passes through server memory only.
-- ----------------------------------------------------------------------------
create or replace function public.add_gemini_key(
  p_user_id uuid,
  p_label text,
  p_raw_key text,
  p_priority smallint default 100
)
returns public.gemini_api_key_refs
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_row public.gemini_api_key_refs;
  v_last4 text;
begin
  if p_raw_key is null or length(p_raw_key) < 8 then
    raise exception 'INVALID_KEY: key looks too short to be valid';
  end if;

  v_last4 := right(p_raw_key, 4);

  v_secret_id := vault.create_secret(
    p_raw_key,
    'gemini_key_' || p_user_id::text || '_' || gen_random_uuid()::text,
    'Gemini API key for app_users.id=' || p_user_id::text
  );

  insert into public.gemini_api_key_refs (user_id, label, vault_secret_id, masked_last4, priority)
  values (p_user_id, coalesce(nullif(p_label, ''), 'Key'), v_secret_id, v_last4, p_priority)
  returning * into v_row;

  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- get_gemini_key_plaintext: decrypts one key for actual use against the
-- Gemini API. SECURITY DEFINER, and deliberately NOT granted to
-- 'authenticated' (see 0011) — only the service role (Edge Functions)
-- can execute it.
-- ----------------------------------------------------------------------------
create or replace function public.get_gemini_key_plaintext(p_key_ref_id uuid)
returns text
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
  v_plain text;
begin
  select vault_secret_id into v_secret_id
  from public.gemini_api_key_refs
  where id = p_key_ref_id;

  if v_secret_id is null then
    raise exception 'KEY_NOT_FOUND';
  end if;

  select decrypted_secret into v_plain
  from vault.decrypted_secrets
  where id = v_secret_id;

  return v_plain;
end;
$$;

-- Ordered, enabled, not-in-cooldown keys for a user — the fallback order
-- the OCR pipeline should try (spec §33 fallback logic).
create or replace function public.list_usable_gemini_keys(p_user_id uuid)
returns setof public.gemini_api_key_refs
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.gemini_api_key_refs
  where user_id = p_user_id
    and enabled = true
    and (cooldown_until is null or cooldown_until < now())
  order by priority asc, created_at asc
$$;

create or replace function public.remove_gemini_key(p_key_ref_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public, vault
as $$
declare
  v_secret_id uuid;
begin
  select vault_secret_id into v_secret_id
  from public.gemini_api_key_refs
  where id = p_key_ref_id and user_id = p_user_id;

  if v_secret_id is null then
    raise exception 'KEY_NOT_FOUND';
  end if;

  delete from public.gemini_api_key_refs where id = p_key_ref_id and user_id = p_user_id;
  delete from vault.secrets where id = v_secret_id;
end;
$$;

create or replace function public.record_gemini_key_test(
  p_key_ref_id uuid, p_ok boolean, p_error text default null
)
returns void
language sql
security definer
set search_path = public
as $$
  update public.gemini_api_key_refs
  set last_tested_at = now(),
      last_test_ok = p_ok,
      last_error = p_error,
      failure_count = case when p_ok then 0 else failure_count + 1 end,
      cooldown_until = case when p_ok then null
                            else now() + (least(failure_count + 1, 6) || ' minutes')::interval
                       end,
      updated_at = now()
  where id = p_key_ref_id;
$$;

create or replace function public.record_gemini_key_used(p_key_ref_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update public.gemini_api_key_refs set last_used_at = now() where id = p_key_ref_id;
$$;
