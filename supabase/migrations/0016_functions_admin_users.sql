-- ============================================================================
-- 0016_functions_admin_users.sql
--
-- Admin user management (spec §14, §15, §31). Every mutating function
-- here re-checks that the caller is an admin (defense in depth — the
-- Edge Function should already have checked this via require_active_user
-- + role, but these functions never trust that alone since they could in
-- principle be reached another way).
-- ============================================================================

create or replace function public.calculate_expiry_date(
  p_start date,
  p_usage_period text,      -- '1_MONTH'|'2_MONTHS'|...|'6_MONTHS'|'1_YEAR'|'FOREVER'|'CUSTOM'
  p_custom_expiry date default null
)
returns date
language plpgsql
immutable
as $$
begin
  return case p_usage_period
    when '1_MONTH'  then (p_start + interval '1 month')::date
    when '2_MONTHS' then (p_start + interval '2 months')::date
    when '3_MONTHS' then (p_start + interval '3 months')::date
    when '4_MONTHS' then (p_start + interval '4 months')::date
    when '5_MONTHS' then (p_start + interval '5 months')::date
    when '6_MONTHS' then (p_start + interval '6 months')::date
    when '1_YEAR'   then (p_start + interval '1 year')::date
    when 'FOREVER'  then null
    when 'CUSTOM'   then p_custom_expiry
    else public.raise_exception_bad_usage_period(p_usage_period)
  end;
end;
$$;

-- Small helper so the CASE above can raise a clear error for an
-- unrecognized usage period value instead of silently returning null.
create or replace function public.raise_exception_bad_usage_period(p_value text)
returns date
language plpgsql
immutable
as $$
begin
  raise exception 'INVALID_USAGE_PERIOD: %', p_value;
end;
$$;

create or replace function public.require_admin(p_actor_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role public.app_role;
begin
  select role into v_role from public.app_users where id = p_actor_user_id;
  if v_role is distinct from 'ADMIN' then
    raise exception 'FORBIDDEN: admin role required' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.admin_create_user(
  p_actor_user_id uuid,
  p_telegram_id bigint,
  p_display_name text,
  p_role public.app_role default 'USER',
  p_start_date date default current_date,
  p_usage_period text default 'FOREVER',
  p_custom_expiry date default null,
  p_language public.app_language default 'en',
  p_timezone text default 'Asia/Phnom_Penh'
)
returns public.app_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.app_users;
begin
  perform public.require_admin(p_actor_user_id);

  insert into public.app_users (telegram_id, display_name, role, status, starts_at, expires_at, language, timezone)
  values (
    p_telegram_id, coalesce(p_display_name, ''), p_role, 'ACTIVE', p_start_date,
    public.calculate_expiry_date(p_start_date, p_usage_period, p_custom_expiry),
    p_language, p_timezone
  )
  returning * into v_row;

  perform public.write_audit_log(p_actor_user_id, 'user.created', 'app_users', v_row.id::text,
    jsonb_build_object('telegram_id', p_telegram_id, 'role', p_role, 'usage_period', p_usage_period));

  return v_row;
end;
$$;

create or replace function public.admin_set_validity(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_status public.app_status default null,
  p_start_date date default null,
  p_usage_period text default null,
  p_custom_expiry date default null
)
returns public.app_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.app_users;
  v_start date;
begin
  perform public.require_admin(p_actor_user_id);

  select * into v_row from public.app_users where id = p_target_user_id;
  if v_row.id is null then
    raise exception 'NOT_FOUND: user % not found', p_target_user_id;
  end if;

  v_start := coalesce(p_start_date, v_row.starts_at);

  update public.app_users
    set status = coalesce(p_status, status),
        starts_at = v_start,
        expires_at = case
          when p_usage_period is not null then public.calculate_expiry_date(v_start, p_usage_period, p_custom_expiry)
          else expires_at
        end
    where id = p_target_user_id
    returning * into v_row;

  perform public.write_audit_log(p_actor_user_id, 'user.validity_changed', 'app_users', v_row.id::text,
    jsonb_build_object('status', p_status, 'usage_period', p_usage_period));

  return v_row;
end;
$$;

create or replace function public.admin_update_user(
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_display_name text default null,
  p_language public.app_language default null,
  p_timezone text default null
)
returns public.app_users
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.app_users;
begin
  perform public.require_admin(p_actor_user_id);
  -- Note: role is deliberately NOT editable here (spec §31: "Do not
  -- allow users to edit their own role" — extended here to mean role
  -- changes need a distinct, explicitly-audited path if ever added).

  update public.app_users
    set display_name = coalesce(p_display_name, display_name),
        language = coalesce(p_language, language),
        timezone = coalesce(p_timezone, timezone)
    where id = p_target_user_id
    returning * into v_row;

  if v_row.id is null then
    raise exception 'NOT_FOUND: user % not found', p_target_user_id;
  end if;

  perform public.write_audit_log(p_actor_user_id, 'user.updated', 'app_users', v_row.id::text, '{}'::jsonb);

  return v_row;
end;
$$;

-- Self-service: a user may change their own language/timezone (not
-- role/status/validity). Used by the "EN/KH toggle" and any future
-- timezone picker (spec §22: "Do not reset the user's chosen language
-- on refresh").
create or replace function public.update_own_profile(
  p_user_id uuid,
  p_language public.app_language default null,
  p_timezone text default null
)
returns public.app_users
language sql
security definer
set search_path = public
as $$
  update public.app_users
    set language = coalesce(p_language, language),
        timezone = coalesce(p_timezone, timezone)
    where id = p_user_id
    returning *;
$$;

create or replace function public.record_user_login(p_telegram_id bigint)
returns public.app_users
language sql
security definer
set search_path = public
as $$
  update public.app_users set last_login_at = now()
  where telegram_id = p_telegram_id
  returning *;
$$;

create or replace function public.admin_list_users(p_actor_user_id uuid)
returns setof public.app_users
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform public.require_admin(p_actor_user_id);
  return query select * from public.app_users order by created_at desc;
end;
$$;
