-- ============================================================================
-- 0008_slip_jobs.sql
--
-- Replaces the legacy `SlipQueue` sheet (spec §12). Tracks each uploaded
-- slip image through OCR, letting the user override the detected type at
-- save time (spec §7 — OCR is a suggestion, never forced).
-- ============================================================================

create type public.slip_status as enum ('READING', 'READY', 'FAILED', 'DUPLICATE', 'SAVED', 'CANCELLED');
create type public.slip_detected_type as enum ('SALE_TRANSACTION', 'EXPENSE', 'UNKNOWN');

create table public.slip_jobs (
  id                    uuid primary key default gen_random_uuid(),
  user_id               uuid not null references public.app_users(id) on delete cascade,

  telegram_chat_id      bigint null,
  telegram_message_id   bigint null,     -- the inline-keyboard message we keep editing

  storage_object_path   text null,       -- e.g. "<user_uuid>/2026/09/<job_id>.jpg" in the "slips" bucket
  original_filename     text null,
  mime_type             text null,
  file_size_bytes        bigint null,
  checksum_sha256       text null,

  status                public.slip_status not null default 'READING',
  detected_type         public.slip_detected_type null,
  selected_save_type    text null check (selected_save_type in ('SALE', 'EXPENSE')),

  transaction_date      text null,       -- as OCR'd, "M/D/YYYY" (kept as text; parsed at save time)
  transaction_time      text null,       -- "HH:mm:ss"
  transaction_at        timestamptz null,

  trx_id                text null,
  trx_id_normalized     text null,

  original_amount       numeric(14,2) null,
  currency              public.currency_code null,
  usd_amount            numeric(14,2) null,

  holder                text null,
  merchant              text null,
  remark                text null,

  raw_ocr_json          jsonb null,
  ocr_model_used        text null,
  ocr_key_ref_id        uuid null references public.gemini_api_key_refs(id) on delete set null,

  error_message         text null,

  saved_record_id       uuid null,       -- points at sales.id or petty_cash_transactions.id once SAVED
  saved_record_type     text null check (saved_record_type in ('sale', 'petty_cash')),

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  cancelled_at          timestamptz null
);

create index slip_jobs_user_status_idx on public.slip_jobs (user_id, status);
create index slip_jobs_user_created_idx on public.slip_jobs (user_id, created_at);
create index slip_jobs_chat_message_idx on public.slip_jobs (telegram_chat_id, telegram_message_id);

create trigger trg_slip_jobs_updated_at
  before update on public.slip_jobs
  for each row execute function public.set_updated_at();

-- Now that slip_jobs exists, wire the forward references from sales /
-- petty_cash_transactions declared as bare uuid columns in 0006 / 0007.
alter table public.sales
  add constraint sales_slip_job_fk foreign key (slip_job_id) references public.slip_jobs(id) on delete set null;

alter table public.petty_cash_transactions
  add constraint petty_cash_slip_job_fk foreign key (slip_job_id) references public.slip_jobs(id) on delete set null;

-- ----------------------------------------------------------------------------
-- Storage: private "slips" bucket (spec §11). Objects are never public;
-- access is via signed URLs issued server-side, or direct Storage RLS
-- (0011) scoped to the owning user's folder prefix "<user_id>/...".
-- ----------------------------------------------------------------------------
insert into storage.buckets (id, name, public)
values ('slips', 'slips', false)
on conflict (id) do nothing;

insert into storage.buckets (id, name, public)
values ('exports', 'exports', false)
on conflict (id) do nothing;
