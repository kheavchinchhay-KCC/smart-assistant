-- ============================================================================
-- 0006_sales.sql
--
-- Sale transactions (replaces the legacy `Transactions` sheet) plus the
-- cross-record `transaction_reference_registry` that makes duplicate
-- Trx/Reference ID checking a single database-level uniqueness guarantee
-- shared between Sale and Petty Cash Expense (spec §5), instead of two
-- sequential full-sheet scans (legacy `transactionIdExists` +
-- `expenseSlipExists`, called together as `slipTransactionExistsAnywhere`).
-- ============================================================================

create type public.currency_code as enum ('USD', 'KHR');
create type public.sale_source as enum ('bank_text', 'manual_missing', 'slip_ocr');

create table public.sales (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.app_users(id) on delete cascade,

  transaction_at      timestamptz not null,     -- authoritative instant, in UTC
  date_local          date not null,            -- denormalized for fast date-preset filtering
  time_local          time not null,

  customer_name       text not null default '-',
  amount              numeric(14,2) not null check (amount > 0),
  currency            public.currency_code not null default 'USD',
  merchant             text not null default '',
  remark              text not null default '',

  trx_id              text not null,            -- as typed/extracted, preserves original formatting
  trx_id_normalized   text not null check (length(trx_id_normalized) > 0),  -- normalize_reference(trx_id)

  source              public.sale_source not null default 'manual_missing',
  raw_text            text not null default '',
  slip_job_id         uuid null,                -- fk added in 0008 after slip_jobs exists

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz null          -- soft delete (spec §30 prefers audit-friendly void)
);

create index sales_user_txat_idx on public.sales (user_id, transaction_at) where deleted_at is null;
create index sales_user_created_idx on public.sales (user_id, created_at) where deleted_at is null;
create index sales_user_ref_idx on public.sales (user_id, trx_id_normalized) where deleted_at is null;
create index sales_user_date_idx on public.sales (user_id, date_local) where deleted_at is null;
create index sales_search_trgm_idx on public.sales
  using gin (customer_name gin_trgm_ops, merchant gin_trgm_ops, remark gin_trgm_ops);

create trigger trg_sales_updated_at
  before update on public.sales
  for each row execute function public.set_updated_at();

-- ----------------------------------------------------------------------------
-- transaction_reference_registry
-- One row per (user, normalized reference), regardless of whether that
-- reference belongs to a Sale or a Petty Cash Expense. The UNIQUE
-- constraint is the actual duplicate guard — inserting here is the first
-- statement of every create_sale / create_petty_cash(type=OUT) call, all
-- inside one transaction, so two racing requests (double-click Save,
-- retried OCR, Sale vs Expense) can never both succeed (spec §52).
-- ----------------------------------------------------------------------------
create table public.transaction_reference_registry (
  user_id             uuid not null references public.app_users(id) on delete cascade,
  normalized_reference text not null,
  source_type         text not null check (source_type in ('sale', 'petty_cash')),
  source_record_id    uuid not null,
  created_at          timestamptz not null default now(),
  primary key (user_id, normalized_reference)
);

comment on table public.transaction_reference_registry is
  'Cross-record (Sale + Petty Cash Expense) duplicate reference guard. '
  'Spec §5: "same user + same normalized Trx/Reference ID cannot be saved '
  'twice, even if one attempt is Sale and another is Expense."';

alter table public.sales
  add constraint sales_ref_fk
  foreign key (user_id, trx_id_normalized)
  references public.transaction_reference_registry (user_id, normalized_reference)
  deferrable initially deferred;

-- Note: this FK is DEFERRABLE INITIALLY DEFERRED because create_sale()
-- (0014) inserts into transaction_reference_registry and sales in the
-- same statement/transaction, in either order; deferring the check
-- avoids ordering constraints inside that function.
