-- ============================================================================
-- 0014_functions_sales_ops.sql
--
-- Write-side Sale operations: replaces Transaction.gs (saveTransaction),
-- MissingTransaction.gs (saveMissingTransaction), and DeleteTransaction.gs.
-- ============================================================================

create or replace function public.create_sale(
  p_user_id uuid,
  p_transaction_at timestamptz,
  p_customer_name text,
  p_amount numeric,
  p_currency public.currency_code,
  p_merchant text,
  p_remark text,
  p_trx_id text,
  p_source public.sale_source,
  p_raw_text text default '',
  p_slip_job_id uuid default null,
  p_actor_user_id uuid default null,
  p_user_timezone text default 'Asia/Phnom_Penh'
)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_ref_norm text;
  v_row public.sales;
  v_local timestamptz;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be positive';
  end if;

  v_ref_norm := public.normalize_reference(p_trx_id);

  if v_ref_norm is null then
    raise exception 'MISSING_TRX_ID: a Sale requires a Trx/Reference ID';
  end if;

  begin
    insert into public.transaction_reference_registry (user_id, normalized_reference, source_type, source_record_id)
    values (p_user_id, v_ref_norm, 'sale', gen_random_uuid());
  exception when unique_violation then
    raise exception 'DUPLICATE_REFERENCE: reference % already used', p_trx_id
      using errcode = '23505';
  end;

  v_local := p_transaction_at at time zone p_user_timezone;

  insert into public.sales (
    user_id, transaction_at, date_local, time_local, customer_name, amount,
    currency, merchant, remark, trx_id, trx_id_normalized, source, raw_text, slip_job_id
  ) values (
    p_user_id, p_transaction_at, v_local::date, v_local::time, coalesce(nullif(p_customer_name,''), '-'),
    p_amount, p_currency, coalesce(p_merchant, ''), coalesce(p_remark, ''), p_trx_id, v_ref_norm,
    p_source, coalesce(p_raw_text, ''), p_slip_job_id
  )
  returning * into v_row;

  update public.transaction_reference_registry
    set source_record_id = v_row.id
    where user_id = p_user_id and normalized_reference = v_ref_norm;

  perform public.write_audit_log(coalesce(p_actor_user_id, p_user_id), 'sale.created', 'sales', v_row.id::text,
    jsonb_build_object('amount', p_amount, 'currency', p_currency, 'source', p_source));

  return v_row;
end;
$$;

create or replace function public.update_sale(
  p_user_id uuid,
  p_sale_id uuid,
  p_customer_name text default null,
  p_amount numeric default null,
  p_currency public.currency_code default null,
  p_merchant text default null,
  p_remark text default null,
  p_actor_user_id uuid default null
)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sales;
begin
  select * into v_row from public.sales where id = p_sale_id and user_id = p_user_id and deleted_at is null;

  if v_row.id is null then
    raise exception 'NOT_FOUND: sale % not found', p_sale_id;
  end if;

  if p_amount is not null and p_amount <= 0 then
    raise exception 'INVALID_AMOUNT: amount must be positive';
  end if;

  update public.sales
    set customer_name = coalesce(nullif(p_customer_name,''), customer_name),
        amount = coalesce(p_amount, amount),
        currency = coalesce(p_currency, currency),
        merchant = coalesce(p_merchant, merchant),
        remark = coalesce(p_remark, remark)
    where id = p_sale_id
    returning * into v_row;

  perform public.write_audit_log(coalesce(p_actor_user_id, p_user_id), 'sale.edited', 'sales', v_row.id::text, '{}'::jsonb);

  return v_row;
end;
$$;

-- delete_sale: soft delete + release the reference so a corrected re-entry
-- of the same Trx ID is possible (mirrors legacy hard delete semantics
-- for duplicate-checking purposes; the row itself is retained for audit).
create or replace function public.delete_sale(
  p_user_id uuid,
  p_sale_id uuid,
  p_actor_user_id uuid default null,
  p_reason text default null
)
returns public.sales
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.sales;
begin
  select * into v_row from public.sales where id = p_sale_id and user_id = p_user_id and deleted_at is null;

  if v_row.id is null then
    raise exception 'NOT_FOUND: sale % not found', p_sale_id;
  end if;

  update public.sales set deleted_at = now() where id = p_sale_id returning * into v_row;

  delete from public.transaction_reference_registry
    where user_id = p_user_id and normalized_reference = v_row.trx_id_normalized;

  perform public.write_audit_log(coalesce(p_actor_user_id, p_user_id), 'sale.deleted', 'sales', v_row.id::text,
    jsonb_build_object('reason', p_reason));

  return v_row;
end;
$$;

-- Kept for parity with legacy transactionIdExists()/findTransactionRowByTrxId,
-- used by the bot before it even attempts create_sale (nicer error UX,
-- e.g. "already exists" vs a generic constraint-violation message).
create or replace function public.sale_reference_exists(p_user_id uuid, p_trx_id text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(
    select 1 from public.transaction_reference_registry
    where user_id = p_user_id and normalized_reference = public.normalize_reference(p_trx_id)
  )
$$;

create or replace function public.find_sale_by_trx_id(p_user_id uuid, p_trx_id text)
returns public.sales
language sql
stable
security definer
set search_path = public
as $$
  select * from public.sales
  where user_id = p_user_id
    and trx_id_normalized = public.normalize_reference(p_trx_id)
    and deleted_at is null
  limit 1
$$;
