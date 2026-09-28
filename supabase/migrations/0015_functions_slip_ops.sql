-- ============================================================================
-- 0015_functions_slip_ops.sql
--
-- OCR slip queue pipeline. Replaces SlipOCR.gs + SlipQueue.gs server-side
-- logic (Gemini's own HTTP call happens in the Edge Function — see
-- supabase/functions/telegram-webhook/ocr.ts — this file is everything
-- that happens to the *result*: classification, duplicate checks,
-- save-as-sale/save-as-expense, retry, cancel).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- reference_exists_anywhere: replaces legacy slipTransactionExistsAnywhere,
-- which ran two sequential full-sheet scans (transactionIdExists +
-- expenseSlipExists). Here it is one indexed lookup against the shared
-- registry (spec §5).
-- ----------------------------------------------------------------------------
create or replace function public.reference_exists_anywhere(p_user_id uuid, p_ref text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.transaction_reference_registry
    where user_id = p_user_id and normalized_reference = public.normalize_reference(p_ref)
  )
$$;

-- ----------------------------------------------------------------------------
-- classify_slip_type: replaces the hardcoded getSlipType() ("PHTEAS
-- DECOR" = Sale). Uses the user's configured shop names / expense holder
-- names (spec §8) as the strong signal, falls back to Gemini's own
-- slipType guess, then to "has a merchant at all => Expense" as the last
-- resort (matching legacy's final fallback).
-- ----------------------------------------------------------------------------
create or replace function public.classify_slip_type(
  p_user_id uuid,
  p_ocr_slip_type text,
  p_ocr_merchant text,
  p_ocr_holder text
)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_shop_names text[];
  v_holder_names text[];
  v_merchant_norm text;
  v_holder_norm text;
  v_name text;
begin
  v_shop_names := public.preferences_shop_names(p_user_id);
  v_holder_names := public.preferences_holder_names(p_user_id);
  v_merchant_norm := upper(regexp_replace(coalesce(p_ocr_merchant, ''), '\s+', '', 'g'));
  v_holder_norm := upper(regexp_replace(coalesce(p_ocr_holder, ''), '\s+', '', 'g'));

  if v_merchant_norm <> '' then
    foreach v_name in array v_shop_names loop
      if v_merchant_norm like '%' || upper(regexp_replace(v_name, '\s+', '', 'g')) || '%' then
        return 'SALE_TRANSACTION';
      end if;
    end loop;
  end if;

  if v_holder_norm <> '' then
    foreach v_name in array v_holder_names loop
      if v_holder_norm like '%' || upper(regexp_replace(v_name, '\s+', '', 'g')) || '%' then
        return 'EXPENSE';
      end if;
    end loop;
  end if;

  if upper(coalesce(p_ocr_slip_type, '')) = 'SALE_TRANSACTION' then
    return 'SALE_TRANSACTION';
  end if;

  if upper(coalesce(p_ocr_slip_type, '')) = 'EXPENSE' then
    return 'EXPENSE';
  end if;

  if v_merchant_norm <> '' then
    return 'EXPENSE';
  end if;

  return null;
end;
$$;

-- Per-user expense-holder normalization/aliasing (replaces the hardcoded
-- KHEAVCHINCHHAY->"KHEAV CHINCHHAY" special case in normalizeExpenseHolder).
create or replace function public.normalize_expense_holder_for_user(p_user_id uuid, p_holder text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_holder_names text[];
  v_input_norm text;
  v_name text;
begin
  if coalesce(trim(p_holder), '') = '' then
    return '-';
  end if;

  v_holder_names := public.preferences_holder_names(p_user_id);
  v_input_norm := upper(regexp_replace(trim(p_holder), '\s+', '', 'g'));

  foreach v_name in array v_holder_names loop
    if upper(regexp_replace(v_name, '\s+', '', 'g')) = v_input_norm then
      return upper(trim(v_name));
    end if;
  end loop;

  return upper(regexp_replace(trim(p_holder), '\s+', ' ', 'g'));
end;
$$;

-- Parses OCR's "M/D/YYYY" + "HH:mm:ss" text pair into a timestamptz in
-- the given IANA timezone. Returns null on anything unparseable so
-- callers can surface "Invalid date or time" the way legacy did.
create or replace function public.parse_slip_datetime(p_date text, p_time text, p_timezone text)
returns timestamptz
language plpgsql
immutable
as $$
declare
  v_date date;
  v_time time;
begin
  if p_date is null or p_time is null or trim(p_date) = '' or trim(p_time) = '' then
    return null;
  end if;

  begin
    v_date := to_date(trim(p_date), 'FMMM/FMDD/FMYYYY');
  exception when others then
    return null;
  end;

  begin
    v_time := trim(p_time)::time;
  exception when others then
    return null;
  end;

  return (v_date + v_time) at time zone p_timezone;
end;
$$;

create table public.gemini_model_cache (
  key_ref_id  uuid primary key references public.gemini_api_key_refs(id) on delete cascade,
  models      jsonb not null default '[]'::jsonb,
  fetched_at  timestamptz not null default now()
);

create or replace function public.get_cached_gemini_models(p_key_ref_id uuid, p_max_age interval default interval '1 hour')
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select models from public.gemini_model_cache
  where key_ref_id = p_key_ref_id and fetched_at > now() - p_max_age
$$;

create or replace function public.set_cached_gemini_models(p_key_ref_id uuid, p_models jsonb)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.gemini_model_cache (key_ref_id, models, fetched_at)
  values (p_key_ref_id, p_models, now())
  on conflict (key_ref_id) do update set models = excluded.models, fetched_at = now();
$$;

create or replace function public.create_slip_job(
  p_user_id uuid,
  p_telegram_chat_id bigint,
  p_telegram_message_id bigint default null,
  p_storage_object_path text default null,
  p_mime_type text default null,
  p_file_size_bytes bigint default null
)
returns public.slip_jobs
language sql
security definer
set search_path = public
as $$
  insert into public.slip_jobs (
    user_id, telegram_chat_id, telegram_message_id, storage_object_path, mime_type, file_size_bytes, status
  ) values (
    p_user_id, p_telegram_chat_id, p_telegram_message_id, p_storage_object_path, p_mime_type, p_file_size_bytes, 'READING'
  )
  returning *;
$$;

-- ----------------------------------------------------------------------------
-- update_slip_job_from_ocr: the heart of readSlipQueueItem() ported.
-- Called by the Edge Function immediately after it gets Gemini's JSON
-- back. Resolves classification, currency conversion, and duplicate
-- status, and leaves the job in exactly one of READY/FAILED/DUPLICATE.
-- ----------------------------------------------------------------------------
create or replace function public.update_slip_job_from_ocr(
  p_slip_job_id uuid,
  p_is_bank_slip boolean,
  p_ocr_result jsonb,
  p_ocr_model text default null,
  p_ocr_key_ref_id uuid default null
)
returns public.slip_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.slip_jobs;
  v_user_id uuid;
  v_slip_type text;
  v_amount numeric;
  v_currency public.currency_code;
  v_usd_amount numeric;
  v_trx_id text;
  v_trx_norm text;
  v_holder text;
  v_merchant text;
  v_remark text;
  v_khr_rate numeric;
  v_default_shop text;
begin
  select * into v_job from public.slip_jobs where id = p_slip_job_id;
  if v_job.id is null then
    raise exception 'SLIP_JOB_NOT_FOUND';
  end if;
  v_user_id := v_job.user_id;

  if not coalesce(p_is_bank_slip, false) then
    update public.slip_jobs
      set status = 'FAILED', detected_type = 'UNKNOWN',
          error_message = 'This image does not look like a bank/payment slip.',
          raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id
      where id = p_slip_job_id
      returning * into v_job;
    return v_job;
  end if;

  v_slip_type := public.classify_slip_type(
    v_user_id, p_ocr_result ->> 'slipType', p_ocr_result ->> 'merchant',
    coalesce(p_ocr_result ->> 'expenseHolder', p_ocr_result ->> 'name')
  );

  v_amount := nullif(p_ocr_result ->> 'amount', '')::numeric;
  v_currency := case when upper(coalesce(p_ocr_result ->> 'currency', 'USD')) = 'KHR' then 'KHR'::public.currency_code else 'USD'::public.currency_code end;
  v_trx_id := nullif(trim(coalesce(p_ocr_result ->> 'trxId', '')), '');
  v_trx_norm := public.normalize_reference(v_trx_id);
  v_merchant := coalesce(p_ocr_result ->> 'merchant', '');
  v_remark := coalesce(nullif(p_ocr_result ->> 'remark', ''), '-');

  select khr_per_usd into v_khr_rate from public.get_or_create_preferences(v_user_id);
  v_usd_amount := case when v_currency = 'KHR' and v_amount is not null then round(v_amount / v_khr_rate, 2) else v_amount end;
  v_default_shop := coalesce((public.preferences_shop_names(v_user_id))[1], 'DEFAULT SHOP');

  if v_slip_type is null then
    update public.slip_jobs
      set status = 'FAILED', detected_type = 'UNKNOWN', error_message = 'Slip type is unclear.',
          raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id
      where id = p_slip_job_id
      returning * into v_job;
    return v_job;
  end if;

  if v_slip_type = 'SALE_TRANSACTION' then
    v_holder := coalesce(nullif(p_ocr_result ->> 'name', ''), nullif(p_ocr_result ->> 'expenseHolder', ''), '-');

    if v_trx_id is null then
      update public.slip_jobs set
        status = 'READY', detected_type = 'SALE_TRANSACTION', trx_id = null, trx_id_normalized = null,
        original_amount = v_amount, currency = v_currency, usd_amount = v_amount, holder = v_holder,
        merchant = coalesce(nullif(v_merchant, ''), v_default_shop), remark = v_remark,
        raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id,
        error_message = 'Sale Trx ID was not found. Save as Expense is still available.',
        transaction_date = p_ocr_result ->> 'transactionDate', transaction_time = p_ocr_result ->> 'transactionTime'
      where id = p_slip_job_id returning * into v_job;
      return v_job;
    end if;

    if public.reference_exists_anywhere(v_user_id, v_trx_id) then
      update public.slip_jobs set
        status = 'DUPLICATE', detected_type = 'SALE_TRANSACTION', trx_id = v_trx_id, trx_id_normalized = v_trx_norm,
        original_amount = v_amount, currency = v_currency, usd_amount = v_amount, holder = v_holder,
        merchant = coalesce(nullif(v_merchant, ''), v_default_shop), remark = v_remark,
        raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id,
        error_message = 'Duplicate transaction ID already exists.',
        transaction_date = p_ocr_result ->> 'transactionDate', transaction_time = p_ocr_result ->> 'transactionTime'
      where id = p_slip_job_id returning * into v_job;
      return v_job;
    end if;

    update public.slip_jobs set
      status = 'READY', detected_type = 'SALE_TRANSACTION', trx_id = v_trx_id, trx_id_normalized = v_trx_norm,
      original_amount = v_amount, currency = v_currency, usd_amount = v_amount, holder = v_holder,
      merchant = coalesce(nullif(v_merchant, ''), v_default_shop), remark = v_remark,
      raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id, error_message = null,
      transaction_date = p_ocr_result ->> 'transactionDate', transaction_time = p_ocr_result ->> 'transactionTime'
    where id = p_slip_job_id returning * into v_job;
    return v_job;
  end if;

  -- EXPENSE
  v_holder := public.normalize_expense_holder_for_user(v_user_id, coalesce(p_ocr_result ->> 'expenseHolder', p_ocr_result ->> 'name'));

  if v_amount is null or v_amount <= 0 then
    update public.slip_jobs set
      status = 'FAILED', detected_type = 'EXPENSE', error_message = 'Expense slip detected, but amount was not found.',
      raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id
    where id = p_slip_job_id returning * into v_job;
    return v_job;
  end if;

  if v_trx_id is not null and public.reference_exists_anywhere(v_user_id, v_trx_id) then
    update public.slip_jobs set
      status = 'DUPLICATE', detected_type = 'EXPENSE', trx_id = v_trx_id, trx_id_normalized = v_trx_norm,
      original_amount = v_amount, currency = v_currency, usd_amount = v_usd_amount, holder = v_holder,
      merchant = coalesce(nullif(v_merchant, ''), '-'), remark = v_remark,
      raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id,
      error_message = 'Duplicate transaction/reference ID already exists.',
      transaction_date = p_ocr_result ->> 'transactionDate', transaction_time = p_ocr_result ->> 'transactionTime'
    where id = p_slip_job_id returning * into v_job;
    return v_job;
  end if;

  update public.slip_jobs set
    status = 'READY', detected_type = 'EXPENSE', trx_id = v_trx_id, trx_id_normalized = v_trx_norm,
    original_amount = v_amount, currency = v_currency, usd_amount = v_usd_amount, holder = v_holder,
    merchant = coalesce(nullif(v_merchant, ''), '-'), remark = v_remark,
    raw_ocr_json = p_ocr_result, ocr_model_used = p_ocr_model, ocr_key_ref_id = p_ocr_key_ref_id, error_message = null,
    transaction_date = p_ocr_result ->> 'transactionDate', transaction_time = p_ocr_result ->> 'transactionTime'
  where id = p_slip_job_id returning * into v_job;
  return v_job;
end;
$$;

-- ----------------------------------------------------------------------------
-- save_slip_as_sale / save_slip_as_expense: the two buttons from spec §7.
-- Both re-check the duplicate registry one more time at click time
-- (legacy did this too — "one final duplicate check at the moment the
-- user clicks Save") because time may have passed since OCR completed.
-- ----------------------------------------------------------------------------
create or replace function public.save_slip_as_sale(p_slip_job_id uuid, p_actor_user_id uuid default null)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.slip_jobs;
  v_sale public.sales;
  v_tz text;
  v_txn_at timestamptz;
begin
  select * into v_job from public.slip_jobs where id = p_slip_job_id;
  if v_job.id is null then raise exception 'SLIP_JOB_NOT_FOUND'; end if;
  if v_job.status <> 'READY' then raise exception 'NOT_READY: slip status is %', v_job.status; end if;

  if v_job.trx_id is null then
    update public.slip_jobs set status = 'FAILED', error_message = 'Trx ID missing. Save as Expense is still available.'
      where id = p_slip_job_id;
    raise exception 'MISSING_TRX_ID';
  end if;

  if public.reference_exists_anywhere(v_job.user_id, v_job.trx_id) then
    update public.slip_jobs set status = 'DUPLICATE', error_message = 'Duplicate transaction/reference ID already exists.'
      where id = p_slip_job_id;
    raise exception 'DUPLICATE_REFERENCE: % already exists', v_job.trx_id using errcode = '23505';
  end if;

  select timezone into v_tz from public.app_users where id = v_job.user_id;
  v_tz := coalesce(v_tz, 'Asia/Phnom_Penh');
  v_txn_at := public.parse_slip_datetime(v_job.transaction_date, v_job.transaction_time, v_tz);

  if v_txn_at is null then
    update public.slip_jobs set status = 'FAILED', error_message = 'Invalid date or time.' where id = p_slip_job_id;
    raise exception 'INVALID_DATETIME';
  end if;

  v_sale := public.create_sale(
    p_user_id => v_job.user_id,
    p_transaction_at => v_txn_at,
    p_customer_name => coalesce(nullif(v_job.holder, ''), '-'),
    p_amount => v_job.original_amount,
    p_currency => v_job.currency,
    p_merchant => coalesce(nullif(v_job.merchant, ''), (public.preferences_shop_names(v_job.user_id))[1], '-'),
    p_remark => coalesce(v_job.remark, ''),
    p_trx_id => v_job.trx_id,
    p_source => 'slip_ocr',
    p_raw_text => 'IMAGE SLIP TRANSACTION',
    p_slip_job_id => p_slip_job_id,
    p_actor_user_id => coalesce(p_actor_user_id, v_job.user_id),
    p_user_timezone => v_tz
  );

  update public.slip_jobs set
    status = 'SAVED', selected_save_type = 'SALE', saved_record_id = v_sale.id, saved_record_type = 'sale', error_message = null
  where id = p_slip_job_id;

  perform public.write_audit_log(coalesce(p_actor_user_id, v_job.user_id), 'ocr.save_as_sale', 'slip_jobs', p_slip_job_id::text, '{}'::jsonb);

  return v_sale;
end;
$$;

create or replace function public.save_slip_as_expense(p_slip_job_id uuid, p_actor_user_id uuid default null)
returns public.petty_cash_transactions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.slip_jobs;
  v_petty public.petty_cash_transactions;
  v_tz text;
  v_txn_at timestamptz;
  v_full_remark text;
begin
  select * into v_job from public.slip_jobs where id = p_slip_job_id;
  if v_job.id is null then raise exception 'SLIP_JOB_NOT_FOUND'; end if;
  if v_job.status <> 'READY' then raise exception 'NOT_READY: slip status is %', v_job.status; end if;

  if v_job.trx_id is not null and public.reference_exists_anywhere(v_job.user_id, v_job.trx_id) then
    update public.slip_jobs set status = 'DUPLICATE', error_message = 'Duplicate transaction/reference ID already exists.'
      where id = p_slip_job_id;
    raise exception 'DUPLICATE_REFERENCE: % already exists', v_job.trx_id using errcode = '23505';
  end if;

  if v_job.original_amount is null or v_job.original_amount <= 0 then
    update public.slip_jobs set status = 'FAILED', error_message = 'Expense amount missing.' where id = p_slip_job_id;
    raise exception 'INVALID_AMOUNT';
  end if;

  select timezone into v_tz from public.app_users where id = v_job.user_id;
  v_tz := coalesce(v_tz, 'Asia/Phnom_Penh');
  v_txn_at := coalesce(public.parse_slip_datetime(v_job.transaction_date, v_job.transaction_time, v_tz), now());

  v_full_remark :=
    'Holder: ' || coalesce(nullif(v_job.holder, ''), '-') ||
    ' | Seller: ' || coalesce(nullif(v_job.merchant, ''), '-') ||
    ' | Original: ' || v_job.currency::text || ' ' || v_job.original_amount::text;

  if v_job.remark is not null and v_job.remark <> '-' and v_job.remark <> '' then
    v_full_remark := v_full_remark || ' | Remark: ' || v_job.remark;
  end if;

  if v_job.trx_id is not null then
    v_full_remark := v_full_remark || ' | Ref: ' || v_job.trx_id;
  end if;

  v_petty := public.create_petty_cash(
    p_user_id => v_job.user_id,
    p_type => 'OUT',
    p_amount => v_job.usd_amount,
    p_remark => v_full_remark,
    p_transaction_at => v_txn_at,
    p_reference => v_job.trx_id,
    p_mode => 'EXPENSE_SLIP',
    p_source => 'Telegram Image',
    p_raw_text => 'EXPENSE SLIP TRX ID: ' || coalesce(v_job.trx_id, ''),
    p_created_by => coalesce(p_actor_user_id, v_job.user_id),
    p_slip_job_id => p_slip_job_id,
    p_user_timezone => v_tz
  );

  update public.slip_jobs set
    status = 'SAVED', selected_save_type = 'EXPENSE', saved_record_id = v_petty.id, saved_record_type = 'petty_cash', error_message = null
  where id = p_slip_job_id;

  perform public.write_audit_log(coalesce(p_actor_user_id, v_job.user_id), 'ocr.save_as_expense', 'slip_jobs', p_slip_job_id::text, '{}'::jsonb);

  return v_petty;
end;
$$;

create or replace function public.retry_slip_job(p_slip_job_id uuid)
returns public.slip_jobs
language sql
security definer
set search_path = public
as $$
  update public.slip_jobs set status = 'READING', error_message = null
  where id = p_slip_job_id and status not in ('SAVED', 'CANCELLED')
  returning *;
$$;

create or replace function public.cancel_slip_job(p_slip_job_id uuid, p_actor_user_id uuid default null)
returns public.slip_jobs
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job public.slip_jobs;
begin
  update public.slip_jobs set status = 'CANCELLED', cancelled_at = now()
  where id = p_slip_job_id and status not in ('SAVED', 'CANCELLED')
  returning * into v_job;

  if v_job.id is not null then
    perform public.write_audit_log(coalesce(p_actor_user_id, v_job.user_id), 'ocr.cancelled', 'slip_jobs', p_slip_job_id::text, '{}'::jsonb);
  end if;

  return v_job;
end;
$$;
