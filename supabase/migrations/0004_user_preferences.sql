-- ============================================================================
-- 0004_user_preferences.sql
--
-- Per-user OCR classification preferences (spec §8) and the KHR/USD rate
-- (spec §4 config, legacy hardcoded KHR_PER_USD=4000 in Config.gs).
-- One row per user, created lazily on first access via
-- get_or_create_preferences().
-- ============================================================================

create table public.user_preferences (
  user_id                     uuid primary key references public.app_users(id) on delete cascade,

  shop_name_1                 text not null default '',
  shop_name_2                 text not null default '',
  shop_name_3                 text not null default '',
  default_shop_name_index     smallint not null default 1 check (default_shop_name_index between 1 and 3),

  expense_holder_1            text not null default '',
  expense_holder_2            text not null default '',
  expense_holder_3            text not null default '',
  default_expense_holder_index smallint not null default 1 check (default_expense_holder_index between 1 and 3),

  khr_per_usd                 numeric(12,4) not null default 4000,   -- legacy default preserved
  low_cash_alert_threshold    numeric(14,2) not null default 100,    -- legacy PETTY_LOW_ALERT default

  selected_gemini_model       text null,

  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create trigger trg_user_preferences_updated_at
  before update on public.user_preferences
  for each row execute function public.set_updated_at();

create or replace function public.get_or_create_preferences(p_user_id uuid)
returns public.user_preferences
language plpgsql
security definer
set search_path = public
as $$
declare
  v_prefs public.user_preferences;
begin
  select * into v_prefs from public.user_preferences where user_id = p_user_id;

  if v_prefs.user_id is null then
    insert into public.user_preferences (user_id) values (p_user_id)
    returning * into v_prefs;
  end if;

  return v_prefs;
end;
$$;

-- Returns the configured shop names / holder names as text[] with blanks
-- removed, for use by the OCR classifier (spec §8: "use these configured
-- shop names as strong Sale indicators").
create or replace function public.preferences_shop_names(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[shop_name_1, shop_name_2, shop_name_3], '')
  from public.get_or_create_preferences(p_user_id)
$$;

create or replace function public.preferences_holder_names(p_user_id uuid)
returns text[]
language sql
stable
security definer
set search_path = public
as $$
  select array_remove(array[expense_holder_1, expense_holder_2, expense_holder_3], '')
  from public.get_or_create_preferences(p_user_id)
$$;
