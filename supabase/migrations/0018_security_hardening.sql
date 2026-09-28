-- ============================================================================
-- 0018_security_hardening.sql
--
-- Additive security/deployment hardening. Do NOT rerun or edit older
-- migrations. This migration:
--   1) re-checks that an API session still belongs to a currently-valid user
--      on every request (deactivation/expiry takes effect immediately);
--   2) removes the service-role-only Gemini helpers that accepted only a key id,
--      replacing them with explicitly user-scoped variants;
--   3) enables RLS on the Gemini model cache;
--   4) keeps all new SECURITY DEFINER helpers callable only by service_role.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Current-session gate: Edge API calls this after verifying the signed JWT.
-- This closes the stale-token window after an admin deactivates/expires a user.
-- ---------------------------------------------------------------------------
create or replace function public.require_current_app_user(p_user_id uuid)
returns public.app_users
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_user public.app_users;
begin
  select * into v_user
  from public.app_users
  where id = p_user_id;

  if v_user.id is null then
    raise exception 'ACCESS_DENIED: user % not found', p_user_id
      using errcode = '28000';
  end if;

  if not public.user_is_currently_valid(v_user) then
    raise exception 'ACCESS_DENIED: user % is not currently valid', p_user_id
      using errcode = '28000';
  end if;

  return v_user;
end;
$$;


-- Harden admin-only helpers themselves: an inactive/blocked/expired admin must
-- not remain privileged just because an old Edge Function caller still has its id.
create or replace function public.require_admin(p_actor_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.app_users;
begin
  select * into v_user from public.app_users where id = p_actor_user_id;
  if v_user.id is null or not public.user_is_currently_valid(v_user) or v_user.role is distinct from 'ADMIN' then
    raise exception 'FORBIDDEN: active admin role required' using errcode = '42501';
  end if;
end;
$$;

revoke execute on function public.require_admin(uuid) from public, anon, authenticated;
revoke execute on function public.require_admin(uuid) from service_role;
grant execute on function public.require_admin(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- Gemini secret retrieval: the old function accepted only a key id. It is
-- removed so an internal caller cannot accidentally retrieve another user's
-- Vault secret without first proving ownership.
-- ---------------------------------------------------------------------------
drop function if exists public.get_gemini_key_plaintext(uuid);

create or replace function public.get_gemini_key_plaintext_for_user(
  p_key_ref_id uuid,
  p_user_id uuid
)
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
  where id = p_key_ref_id
    and user_id = p_user_id;

  if v_secret_id is null then
    raise exception 'KEY_NOT_FOUND';
  end if;

  select decrypted_secret into v_plain
  from vault.decrypted_secrets
  where id = v_secret_id;

  if v_plain is null then
    raise exception 'KEY_NOT_FOUND';
  end if;

  return v_plain;
end;
$$;

-- ---------------------------------------------------------------------------
-- Gemini model cache: the cache was not included in the original RLS set and
-- its helper functions accepted only a key id. Replace both helpers with
-- explicitly owner-scoped variants and add an owner-only RLS policy.
-- ---------------------------------------------------------------------------
alter table public.gemini_model_cache enable row level security;

drop policy if exists gemini_model_cache_owner_only on public.gemini_model_cache;
create policy gemini_model_cache_owner_only on public.gemini_model_cache
  for select
  using (
    exists (
      select 1
      from public.gemini_api_key_refs k
      where k.id = gemini_model_cache.key_ref_id
        and k.user_id = public.jwt_app_user_id()
    )
  );

drop function if exists public.get_cached_gemini_models(uuid, interval);
drop function if exists public.set_cached_gemini_models(uuid, jsonb);

create or replace function public.get_cached_gemini_models_for_user(
  p_key_ref_id uuid,
  p_user_id uuid,
  p_max_age interval default interval '1 hour'
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select c.models
  from public.gemini_model_cache c
  join public.gemini_api_key_refs k on k.id = c.key_ref_id
  where c.key_ref_id = p_key_ref_id
    and k.user_id = p_user_id
    and c.fetched_at > now() - p_max_age
$$;

create or replace function public.set_cached_gemini_models_for_user(
  p_key_ref_id uuid,
  p_user_id uuid,
  p_models jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.gemini_api_key_refs
    where id = p_key_ref_id and user_id = p_user_id
  ) then
    raise exception 'KEY_NOT_FOUND';
  end if;

  insert into public.gemini_model_cache (key_ref_id, models, fetched_at)
  values (p_key_ref_id, coalesce(p_models, '[]'::jsonb), now())
  on conflict (key_ref_id) do update
    set models = excluded.models,
        fetched_at = now();
end;
$$;

-- ---------------------------------------------------------------------------
-- Gemini usage/test bookkeeping is also explicitly owner-scoped. These are
-- not directly reachable by normal clients, but the extra predicate prevents
-- a future internal caller from changing another user's key status by id.
-- ---------------------------------------------------------------------------
drop function if exists public.record_gemini_key_test(uuid, boolean, text);
drop function if exists public.record_gemini_key_used(uuid);

create or replace function public.record_gemini_key_test(
  p_key_ref_id uuid,
  p_user_id uuid,
  p_ok boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.gemini_api_key_refs
  set last_tested_at = now(),
      last_test_ok = p_ok,
      last_error = case when p_error is null then null else left(p_error, 500) end,
      failure_count = case when p_ok then 0 else failure_count + 1 end,
      cooldown_until = case when p_ok then null
                            else now() + (least(failure_count + 1, 6) || ' minutes')::interval
                       end,
      updated_at = now()
  where id = p_key_ref_id
    and user_id = p_user_id;

  if not found then
    raise exception 'KEY_NOT_FOUND';
  end if;
end;
$$;

create or replace function public.record_gemini_key_used(
  p_key_ref_id uuid,
  p_user_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.gemini_api_key_refs
  set last_used_at = now(), updated_at = now()
  where id = p_key_ref_id
    and user_id = p_user_id;

  if not found then
    raise exception 'KEY_NOT_FOUND';
  end if;
end;
$$;

-- The browser never needs direct PostgREST table writes: all protected web
-- operations go through the API Edge Function, which authenticates the custom
-- Telegram session and then uses the service role. Remove authenticated/anon
-- table privileges so callers cannot bypass business rules (duplicate-reference
-- registry, running-balance maintenance, audit logging, validation, etc.) by
-- writing directly to the base tables. RLS remains enabled as defense in depth.
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- New functions created after 0017 would otherwise regain PUBLIC EXECUTE.
-- Keep the project-wide security model explicit.
revoke execute on function public.require_current_app_user(uuid) from public, anon, authenticated;
revoke execute on function public.get_gemini_key_plaintext_for_user(uuid, uuid) from public, anon, authenticated;
revoke execute on function public.get_cached_gemini_models_for_user(uuid, uuid, interval) from public, anon, authenticated;
revoke execute on function public.set_cached_gemini_models_for_user(uuid, uuid, jsonb) from public, anon, authenticated;
revoke execute on function public.record_gemini_key_test(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke execute on function public.record_gemini_key_used(uuid, uuid) from public, anon, authenticated;

revoke execute on function public.require_current_app_user(uuid) from service_role;
revoke execute on function public.get_gemini_key_plaintext_for_user(uuid, uuid) from service_role;
revoke execute on function public.get_cached_gemini_models_for_user(uuid, uuid, interval) from service_role;
revoke execute on function public.set_cached_gemini_models_for_user(uuid, uuid, jsonb) from service_role;
revoke execute on function public.record_gemini_key_test(uuid, uuid, boolean, text) from service_role;
revoke execute on function public.record_gemini_key_used(uuid, uuid) from service_role;

grant execute on function public.require_current_app_user(uuid) to service_role;
grant execute on function public.get_gemini_key_plaintext_for_user(uuid, uuid) to service_role;
grant execute on function public.get_cached_gemini_models_for_user(uuid, uuid, interval) to service_role;
grant execute on function public.set_cached_gemini_models_for_user(uuid, uuid, jsonb) to service_role;
grant execute on function public.record_gemini_key_test(uuid, uuid, boolean, text) to service_role;
grant execute on function public.record_gemini_key_used(uuid, uuid) to service_role;
