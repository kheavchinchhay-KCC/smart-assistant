-- ============================================================================
-- 0002_app_users.sql
--
-- Multi-user account table. One row per Telegram user allowed to use the
-- system (bot or web app). Access rules (spec section 14-15) are enforced
-- by the require_active_user() function below, called from every
-- protected RPC and from the telegram-webhook Edge Function before any
-- command is processed.
-- ============================================================================

create type public.app_role as enum ('ADMIN', 'USER');
create type public.app_status as enum ('ACTIVE', 'INACTIVE', 'BLOCKED', 'EXPIRED');
create type public.app_language as enum ('en', 'kh');

create table public.app_users (
  id                uuid primary key default gen_random_uuid(),
  telegram_id       bigint not null unique,
  display_name      text not null default '',
  role              public.app_role not null default 'USER',
  status            public.app_status not null default 'ACTIVE',
  starts_at         date not null default current_date,
  expires_at        date null,                    -- null = Forever
  language          public.app_language not null default 'en',
  timezone          text not null default 'Asia/Phnom_Penh',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  last_login_at     timestamptz null
);

create index app_users_telegram_id_idx on public.app_users (telegram_id);
create index app_users_status_idx on public.app_users (status);

create trigger trg_app_users_updated_at
  before update on public.app_users
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- Computed validity: a user is usable right now iff status=ACTIVE,
-- starts_at <= today, and (expires_at is null or expires_at >= today).
-- Expressed as a function (not a generated column) so "today" is always
-- evaluated fresh, and so bot/API code can call the exact same rule.
-- ----------------------------------------------------------------------------
create or replace function public.user_is_currently_valid(p_user public.app_users)
returns boolean
language sql
stable
as $$
  select
    p_user.status = 'ACTIVE'
    and p_user.starts_at <= (now() at time zone p_user.timezone)::date
    and (p_user.expires_at is null or p_user.expires_at >= (now() at time zone p_user.timezone)::date)
$$;

-- Effective status label for UI/header display (handles the "EXPIRED"
-- and "future start date" cases that the raw `status` column doesn't
-- capture on its own, per spec section 14-15).
create or replace function public.user_effective_status(p_user public.app_users)
returns text
language sql
stable
as $$
  select case
    when p_user.status in ('INACTIVE', 'BLOCKED') then p_user.status::text
    when p_user.expires_at is not null and p_user.expires_at < (now() at time zone p_user.timezone)::date then 'EXPIRED'
    when p_user.starts_at > (now() at time zone p_user.timezone)::date then 'PENDING_START'
    else 'ACTIVE'
  end
$$;

-- ----------------------------------------------------------------------------
-- require_active_user: central access gate. Raises if the caller's
-- Telegram id does not map to a currently-valid user. Returns the
-- app_users row on success so callers get id/role/timezone in one call.
-- SECURITY DEFINER so it can be called by RPCs exposed to the
-- 'authenticated' role without granting that role direct table access.
-- ----------------------------------------------------------------------------
create or replace function public.require_active_user(p_telegram_id bigint)
returns public.app_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user public.app_users;
begin
  select * into v_user from public.app_users where telegram_id = p_telegram_id;

  if v_user.id is null then
    raise exception 'ACCESS_DENIED: telegram user % is not registered', p_telegram_id
      using errcode = '28000';
  end if;

  if not public.user_is_currently_valid(v_user) then
    raise exception 'ACCESS_DENIED: user % is not currently valid (status=%)',
      p_telegram_id, public.user_effective_status(v_user)
      using errcode = '28000';
  end if;

  return v_user;
end;
$$;

comment on function public.require_active_user is
  'Central access gate (spec §14 access rules). Call at the start of every '
  'protected bot command and API operation. Raises SQLSTATE 28000 on denial.';
