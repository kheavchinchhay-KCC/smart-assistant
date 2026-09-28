-- ============================================================================
-- 0009_exports.sql
--
-- Tracks generated Excel/PDF export files (spec §40-44). Files themselves
-- live in the private "exports" Storage bucket (created in 0008); this
-- table is the audit trail + expiry bookkeeping, and is what
-- createSaleExport/createPettyExport/sendTelegramExport (spec §60) write
-- to and read from.
-- ============================================================================

create type public.export_type as enum ('sale', 'petty_cash');
create type public.export_format as enum ('xlsx', 'pdf');

create table public.exports (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references public.app_users(id) on delete cascade,

  export_type         public.export_type not null,
  format              public.export_format not null,

  start_at            timestamptz not null,
  end_at              timestamptz not null,

  storage_object_path text not null,     -- "<user_id>/<export_id>.xlsx" in "exports" bucket
  row_count           integer not null default 0,

  requested_via       text not null default 'telegram' check (requested_via in ('telegram', 'web')),
  expires_at          timestamptz not null default (now() + interval '24 hours'),

  created_at          timestamptz not null default now()
);

create index exports_user_created_idx on public.exports (user_id, created_at);
