-- ============================================================================
-- 0010_audit_log.sql
--
-- Central audit trail for sensitive actions (spec §49). Never stores
-- secrets — write_audit_log() takes a jsonb `details` blob and callers
-- are responsible for keeping key material and tokens out of it (enforced
-- by convention + code review, since Postgres can't know what a string
-- "means").
-- ============================================================================

create table public.audit_log (
  id           bigint generated always as identity primary key,
  actor_user_id uuid null references public.app_users(id) on delete set null,
  action       text not null,     -- e.g. 'sale.created', 'user.activated', 'gemini_key.added'
  target_type  text null,         -- e.g. 'sale', 'app_users', 'petty_cash_transactions'
  target_id    text null,
  details      jsonb not null default '{}'::jsonb,
  ip_hash      text null,         -- if ever available (web requests); never raw IP
  created_at   timestamptz not null default now()
);

create index audit_log_actor_idx on public.audit_log (actor_user_id, created_at desc);
create index audit_log_action_idx on public.audit_log (action, created_at desc);

create or replace function public.write_audit_log(
  p_actor_user_id uuid,
  p_action text,
  p_target_type text default null,
  p_target_id text default null,
  p_details jsonb default '{}'::jsonb
)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.audit_log (actor_user_id, action, target_type, target_id, details)
  values (p_actor_user_id, p_action, p_target_type, p_target_id, p_details);
$$;
