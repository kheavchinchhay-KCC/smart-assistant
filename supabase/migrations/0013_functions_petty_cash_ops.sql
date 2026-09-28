-- ============================================================================
-- 0013_functions_petty_cash_ops.sql
--
-- Write-side Petty Cash operations. Each function is one transaction, so
-- concurrent double-clicks / racing requests are handled by Postgres row
-- locking and the transaction_reference_registry UNIQUE constraint
-- (spec §52), not by application-level locking.
-- ============================================================================

create or replace function public.find_petty_by_display_id(p_user_id uuid, p_display_id text)
returns public.petty_cash_transactions
language sql
stable
security definer
set search_path = public
as $$
  select * from public.petty_cash_transactions
  where user_id = p_user_id
    and display_id = upper(trim(p_display_id))
    and deleted_at is null
$$;

-- ----------------------------------------------------------------------------
-- create_petty_cash: the one function behind Cash In, Expense, Missing
-- Cash In/Expense, and (via save_slip_as_expense in 0015) OCR expense
-- slips. p_reference is optional; when provided it goes through the
-- shared duplicate registry so it can never collide with a Sale's
-- trx_id either (spec §5).
-- ----------------------------------------------------------------------------
create or replace function public.create_petty_cash(
  p_user_id uuid,
  p_type public.petty_cash_type,
  p_amount numeric,
  p_remark text,
  p_transaction_at timestamptz,
  p_reference text default null,
  p_mode public.petty_cash_mode default 'NORMAL',
  p_source text default 'Telegram',
  p_raw_text text default '',
  p_created_by uuid default null,
  p_slip_job_id uuid default null,
  p_user_timezone text default 'Asia/Phnom_Penh'
)
returns public.petty_cash_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_display_id text;
  v_ref_norm text;
  v_row public.petty_cash_transactions;
  v_local timestamptz;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be positive';
  end if;

  v_ref_norm := public.normalize_reference(p_reference);

  if v_ref_norm is not null then
    -- Atomic duplicate guard shared with Sales (spec §5). A unique
    -- violation here is caught and re-raised as a clear, catchable error
    -- code the Edge Function can map to "Duplicate Transaction".
    begin
      insert into public.transaction_reference_registry (user_id, normalized_reference, source_type, source_record_id)
      values (p_user_id, v_ref_norm, 'petty_cash', gen_random_uuid()); -- placeholder id, corrected below
    exception when unique_violation then
      raise exception 'DUPLICATE_REFERENCE: reference % already used', p_reference
        using errcode = '23505';
    end;
  end if;

  v_display_id := public.format_petty_display_id(public.next_petty_display_number(p_user_id));
  v_local := p_transaction_at at time zone p_user_timezone;

  insert into public.petty_cash_transactions (
    user_id, display_id, transaction_at, date_local, time_local,
    type, amount, remark, reference, reference_normalized,
    mode, source, raw_text, slip_job_id, created_by
  ) values (
    p_user_id, v_display_id, p_transaction_at, v_local::date, v_local::time,
    p_type, p_amount, coalesce(p_remark, ''), p_reference, v_ref_norm,
    p_mode, p_source, coalesce(p_raw_text, ''), p_slip_job_id, coalesce(p_created_by, p_user_id)
  )
  returning * into v_row;

  -- Fix up the registry row's source_record_id now that we have the real id.
  if v_ref_norm is not null then
    update public.transaction_reference_registry
      set source_record_id = v_row.id
      where user_id = p_user_id and normalized_reference = v_ref_norm;
  end if;

  perform public.write_audit_log(p_created_by, 'petty_cash.created', 'petty_cash_transactions', v_row.id::text,
    jsonb_build_object('type', p_type, 'amount', p_amount, 'mode', p_mode));

  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- update_petty_cash: legacy editPettyCashById only ever changed
-- amount/remark (never date/type), so those stay optional-but-typical;
-- transaction_at is exposed too for admin corrections but is nullable
-- (pass null to leave unchanged).
-- ----------------------------------------------------------------------------
create or replace function public.update_petty_cash(
  p_user_id uuid,
  p_display_id text,
  p_amount numeric default null,
  p_remark text default null,
  p_transaction_at timestamptz default null,
  p_actor_user_id uuid default null,
  p_user_timezone text default 'Asia/Phnom_Penh'
)
returns public.petty_cash_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.petty_cash_transactions;
  v_local timestamptz;
begin
  select * into v_row from public.find_petty_by_display_id(p_user_id, p_display_id);

  if v_row.id is null then
    raise exception 'NOT_FOUND: petty cash % not found', p_display_id;
  end if;

  if p_amount is not null and p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be positive';
  end if;

  if p_transaction_at is not null then
    v_local := p_transaction_at at time zone p_user_timezone;
  end if;

  update public.petty_cash_transactions
    set amount = coalesce(p_amount, amount),
        remark = coalesce(p_remark, remark),
        transaction_at = coalesce(p_transaction_at, transaction_at),
        date_local = coalesce(v_local::date, date_local),
        time_local = coalesce(v_local::time, time_local)
    where id = v_row.id
    returning * into v_row;

  perform public.write_audit_log(coalesce(p_actor_user_id, p_user_id), 'petty_cash.edited',
    'petty_cash_transactions', v_row.id::text,
    jsonb_build_object('new_amount', p_amount, 'new_remark', p_remark));

  return v_row;
end;
$$;

-- ----------------------------------------------------------------------------
-- delete_petty_cash: soft delete + audit event (spec §30 accepts either
-- soft delete or hard delete + audit; we soft-delete). The reference
-- registry row is released so a legitimately-corrected reference number
-- can be reused, mirroring legacy hard-delete semantics for the ID.
-- ----------------------------------------------------------------------------
create or replace function public.delete_petty_cash(
  p_user_id uuid,
  p_display_id text,
  p_actor_user_id uuid default null,
  p_reason text default null
)
returns public.petty_cash_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.petty_cash_transactions;
begin
  select * into v_row from public.find_petty_by_display_id(p_user_id, p_display_id);

  if v_row.id is null then
    raise exception 'NOT_FOUND: petty cash % not found', p_display_id;
  end if;

  update public.petty_cash_transactions
    set deleted_at = now(), deleted_reason = p_reason
    where id = v_row.id
    returning * into v_row;

  if v_row.reference_normalized is not null then
    delete from public.transaction_reference_registry
      where user_id = p_user_id and normalized_reference = v_row.reference_normalized;
  end if;

  perform public.write_audit_log(coalesce(p_actor_user_id, p_user_id), 'petty_cash.deleted',
    'petty_cash_transactions', v_row.id::text, jsonb_build_object('reason', p_reason));

  return v_row;
end;
$$;
