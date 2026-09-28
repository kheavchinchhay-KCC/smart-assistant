-- ============================================================================
-- 0007_petty_cash.sql
--
-- Petty Cash ledger. This is the migration the spec is strictest about
-- (§4, §20, §67 acceptance test): NO physically re-sorted rows, NO stored
-- "Current Cash" column copied onto every row, NO row-number IDs.
--
-- Design:
--   - petty_cash_transactions is a pure append-mostly ledger (soft delete
--     only). IN is positive, OUT is negative, by convention of the `type`
--     column (amount itself is always stored positive).
--   - Running balance and current cash are NEVER stored — they are
--     derived on read via SUM(...) OVER (...) window functions
--     (petty_cash_running view) or a plain SUM (current_petty_cash_balance
--     function). Inserting a backdated row therefore "just works": every
--     later row's running balance recomputes automatically on next read,
--     with no re-sort/rewrite step.
--   - The legacy human-readable "PC000123" display id is preserved for
--     continuity (spec §56: legacy IDs like PC000150 must not be reused),
--     generated from a per-user counter row advanced with a row lock
--     (`select ... for update`), which is safe under concurrent inserts.
--     The real primary key is a uuid; the display id is a separate,
--     purely cosmetic column.
-- ============================================================================

create type public.petty_cash_type as enum ('IN', 'OUT');
create type public.petty_cash_mode as enum ('NORMAL', 'MISSING', 'EXPENSE_SLIP');

create table public.petty_cash_id_counters (
  user_id      uuid primary key references public.app_users(id) on delete cascade,
  next_number  bigint not null default 1
);

-- Advances (and returns) the next display number for a user, taking a
-- row lock so concurrent requests never receive the same number.
create or replace function public.next_petty_display_number(p_user_id uuid)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_number bigint;
begin
  insert into public.petty_cash_id_counters (user_id, next_number)
  values (p_user_id, 1)
  on conflict (user_id) do nothing;

  update public.petty_cash_id_counters
    set next_number = next_number + 1
    where user_id = p_user_id
    returning next_number - 1 into v_number;

  return v_number;
end;
$$;

create or replace function public.format_petty_display_id(p_number bigint)
returns text
language sql
immutable
as $$
  select 'PC' || lpad(p_number::text, 6, '0')
$$;

create table public.petty_cash_transactions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.app_users(id) on delete cascade,

  display_id       text not null,             -- e.g. "PC000123", legacy-format, per-user unique

  transaction_at   timestamptz not null,      -- authoritative instant (supports backdating)
  date_local       date not null,
  time_local       time not null,

  type             public.petty_cash_type not null,
  amount           numeric(14,2) not null check (amount > 0),   -- always positive; type carries sign
  remark           text not null default '',

  reference        text null,                  -- optional Trx/Ref id (mainly for EXPENSE_SLIP)
  reference_normalized text null,

  mode             public.petty_cash_mode not null default 'NORMAL',
  source           text not null default 'Telegram',
  raw_text         text not null default '',
  slip_job_id      uuid null,                   -- fk added in 0008

  created_by       uuid not null references public.app_users(id),  -- who recorded it (may differ from user_id if ever shared; today == user_id)

  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz null,
  deleted_reason   text null
);

create unique index petty_cash_display_id_uidx on public.petty_cash_transactions (user_id, display_id);
create index petty_cash_user_txat_idx on public.petty_cash_transactions (user_id, transaction_at) where deleted_at is null;
create index petty_cash_user_created_idx on public.petty_cash_transactions (user_id, created_at) where deleted_at is null;
create index petty_cash_user_date_idx on public.petty_cash_transactions (user_id, date_local) where deleted_at is null;
create index petty_cash_user_ref_idx on public.petty_cash_transactions (user_id, reference_normalized) where deleted_at is null;
create index petty_cash_search_trgm_idx on public.petty_cash_transactions
  using gin (remark gin_trgm_ops, display_id gin_trgm_ops);

create trigger trg_petty_cash_updated_at
  before update on public.petty_cash_transactions
  for each row execute function public.set_updated_at();

alter table public.petty_cash_transactions
  add constraint petty_cash_ref_fk
  foreign key (user_id, reference_normalized)
  references public.transaction_reference_registry (user_id, normalized_reference)
  deferrable initially deferred;
-- NULL reference_normalized never triggers the FK (multi-column FKs with
-- any NULL column are automatically satisfied), so Cash In / plain
-- Expense entries with no reference are unaffected.

-- ----------------------------------------------------------------------------
-- petty_cash_running: the ledger with a derived running balance per user,
-- ordered by (transaction_at, created_at, id) as a deterministic
-- tie-breaker (spec §20 explicitly requires this ordering triple).
-- ----------------------------------------------------------------------------
create or replace view public.petty_cash_running as
select
  pct.*,
  sum(case when pct.type = 'IN' then pct.amount else -pct.amount end)
    over (
      partition by pct.user_id
      order by pct.transaction_at, pct.created_at, pct.id
      rows between unbounded preceding and current row
    ) as running_balance
from public.petty_cash_transactions pct
where pct.deleted_at is null;

comment on view public.petty_cash_running is
  'Ledger + derived running balance (window function, spec §20). Never '
  'stored — recomputes correctly after backdated inserts/edits/deletes '
  'with no manual re-sort step. See §67 acceptance test.';

-- Current cash on hand: the simple lifetime sum (equivalent to the
-- running balance of the chronologically-last row, but cheaper to state
-- directly and correct even with zero rows).
create or replace function public.current_petty_cash_balance(p_user_id uuid)
returns numeric
language sql
stable
as $$
  select coalesce(
    sum(case when type = 'IN' then amount else -amount end),
    0
  )
  from public.petty_cash_transactions
  where user_id = p_user_id and deleted_at is null
$$;
