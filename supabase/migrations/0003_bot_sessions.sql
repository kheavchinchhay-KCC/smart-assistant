-- ============================================================================
-- 0003_bot_sessions.sql
--
-- Replaces two legacy mechanisms with one table:
--   1. The `BotState` sheet (Utils.gs setState/getState) — per-chat
--      conversation state, e.g. "petty_missing_date_in".
--   2. PropertiesService key/value temp data (PettyCash.gs
--      setTempData/getTempData) — free-form scratch data collected across
--      a multi-step conversation (e.g. missing_trx_date, slip_trxid).
--
-- Both collapse naturally into one jsonb column per chat. This table is
-- only ever touched by the telegram-webhook Edge Function using the
-- service role key — it is not exposed to the frontend and has no RLS
-- policies granting client access (see 0011).
-- ============================================================================

create table public.bot_sessions (
  chat_id     bigint primary key,
  user_id     uuid references public.app_users(id) on delete set null,
  state       text not null default '',
  temp_data   jsonb not null default '{}'::jsonb,
  updated_at  timestamptz not null default now()
);

create trigger trg_bot_sessions_updated_at
  before update on public.bot_sessions
  for each row execute function public.set_updated_at();

-- Convenience upsert-style setters used by the webhook function via RPC,
-- so simple state transitions don't need a read-modify-write round trip
-- from Deno.

create or replace function public.bot_set_state(p_chat_id bigint, p_state text)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.bot_sessions (chat_id, state)
  values (p_chat_id, coalesce(p_state, ''))
  on conflict (chat_id) do update set state = excluded.state, updated_at = now();
$$;

create or replace function public.bot_get_state(p_chat_id bigint)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select state from public.bot_sessions where chat_id = p_chat_id), '')
$$;

create or replace function public.bot_set_temp(p_chat_id bigint, p_key text, p_value text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.bot_sessions (chat_id, temp_data)
  values (p_chat_id, jsonb_build_object(p_key, p_value))
  on conflict (chat_id) do update
    set temp_data = public.bot_sessions.temp_data || jsonb_build_object(p_key, p_value),
        updated_at = now();
end;
$$;

create or replace function public.bot_get_temp(p_chat_id bigint, p_key text)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select temp_data ->> p_key from public.bot_sessions where chat_id = p_chat_id
$$;

create or replace function public.bot_clear_temp(p_chat_id bigint, p_key text)
returns void
language sql
security definer
set search_path = public
as $$
  update public.bot_sessions
    set temp_data = temp_data - p_key, updated_at = now()
    where chat_id = p_chat_id;
$$;

create or replace function public.bot_clear_state(p_chat_id bigint)
returns void
language sql
security definer
set search_path = public
as $$
  update public.bot_sessions set state = '', updated_at = now() where chat_id = p_chat_id;
$$;
