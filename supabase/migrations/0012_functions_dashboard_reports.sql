-- ============================================================================
-- 0012_functions_dashboard_reports.sql
--
-- Read-side aggregate functions backing:
--   - Reports.gs (today/yesterday/weekly/monthly/date/date-range, customer/
--     merchant search, top 10 customers/merchants)
--   - DashBoard.gs (refreshDashboard) — replaced by a single live query,
--     no stored sheet, no nightly trigger (spec §23, §51: "Do not make
--     the dashboard a giant slow page... use efficient aggregate queries")
--
-- All functions are STABLE and take an explicit p_user_id — they are only
-- ever called from Edge Functions (service role) that have already
-- resolved and authorized that user_id; see 0011 security-model note.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- sale_summary: count + USD/KHR totals for a date range, in the user's
-- timezone. Callers pass already-computed UTC timestamptz bounds (the
-- Edge Function resolves date presets in the user's timezone — see
-- spec §46 — then converts to UTC before calling this).
-- ----------------------------------------------------------------------------
create or replace function public.sale_summary(p_user_id uuid, p_start timestamptz, p_end timestamptz)
returns table (
  transaction_count bigint,
  usd_total numeric,
  khr_total numeric,
  last_transaction_at timestamptz,
  last_customer_name text
)
language sql
stable
security definer
set search_path = public
as $$
  select
    count(*) as transaction_count,
    coalesce(sum(amount) filter (where currency = 'USD'), 0) as usd_total,
    coalesce(sum(amount) filter (where currency = 'KHR'), 0) as khr_total,
    max(transaction_at) as last_transaction_at,
    (array_agg(customer_name order by transaction_at desc))[1] as last_customer_name
  from public.sales
  where user_id = p_user_id
    and deleted_at is null
    and transaction_at >= p_start
    and transaction_at <= p_end
$$;

-- ----------------------------------------------------------------------------
-- petty_cash_summary: Cash In / Expense / Balance for a range, plus the
-- lifetime Current Cash figure (kept separate on purpose — spec §28: "Be
-- explicit so the user does not confuse period balance with current cash
-- on hand").
-- ----------------------------------------------------------------------------
create or replace function public.petty_cash_summary(p_user_id uuid, p_start timestamptz, p_end timestamptz)
returns table (
  cash_in numeric,
  expense numeric,
  period_balance numeric,
  current_cash numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    coalesce(sum(amount) filter (where type = 'IN'), 0) as cash_in,
    coalesce(sum(amount) filter (where type = 'OUT'), 0) as expense,
    coalesce(sum(amount) filter (where type = 'IN'), 0) - coalesce(sum(amount) filter (where type = 'OUT'), 0) as period_balance,
    public.current_petty_cash_balance(p_user_id) as current_cash
  from public.petty_cash_transactions
  where user_id = p_user_id
    and deleted_at is null
    and transaction_at >= p_start
    and transaction_at <= p_end
$$;

-- ----------------------------------------------------------------------------
-- top_customers / top_merchants: top N by USD total (ties broken by
-- transaction count), matching legacy Reports.gs sort order.
-- ----------------------------------------------------------------------------
create or replace function public.top_customers(p_user_id uuid, p_limit integer default 10)
returns table (customer_name text, usd_total numeric, khr_total numeric, transaction_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    customer_name,
    sum(amount) filter (where currency = 'USD') as usd_total,
    coalesce(sum(amount) filter (where currency = 'KHR'), 0) as khr_total,
    count(*) as transaction_count
  from public.sales
  where user_id = p_user_id and deleted_at is null
  group by customer_name
  order by usd_total desc nulls last, transaction_count desc
  limit p_limit
$$;

create or replace function public.top_merchants(p_user_id uuid, p_limit integer default 10)
returns table (merchant text, usd_total numeric, khr_total numeric, transaction_count bigint)
language sql
stable
security definer
set search_path = public
as $$
  select
    merchant,
    sum(amount) filter (where currency = 'USD') as usd_total,
    coalesce(sum(amount) filter (where currency = 'KHR'), 0) as khr_total,
    count(*) as transaction_count
  from public.sales
  where user_id = p_user_id and deleted_at is null and merchant <> ''
  group by merchant
  order by usd_total desc nulls last, transaction_count desc
  limit p_limit
$$;

-- ----------------------------------------------------------------------------
-- search_sales / search_petty: server-side, user-scoped, paginated
-- (spec §45, §51: "no full-table scans", trigram-indexed ILIKE).
-- keyword may be empty (returns latest rows, still paginated).
-- ----------------------------------------------------------------------------
create or replace function public.search_sales(
  p_user_id uuid,
  p_keyword text default '',
  p_start timestamptz default null,
  p_end timestamptz default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid, transaction_at timestamptz, customer_name text, amount numeric,
  currency public.currency_code, merchant text, remark text, trx_id text,
  source public.sale_source, total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with filtered as (
    select s.*
    from public.sales s
    where s.user_id = p_user_id
      and s.deleted_at is null
      and (p_start is null or s.transaction_at >= p_start)
      and (p_end is null or s.transaction_at <= p_end)
      and (
        p_keyword = '' or p_keyword is null
        or s.trx_id ilike '%' || p_keyword || '%'
        or s.customer_name ilike '%' || p_keyword || '%'
        or s.merchant ilike '%' || p_keyword || '%'
        or s.remark ilike '%' || p_keyword || '%'
      )
  )
  select f.id, f.transaction_at, f.customer_name, f.amount, f.currency,
         f.merchant, f.remark, f.trx_id, f.source,
         count(*) over () as total_count
  from filtered f
  order by f.transaction_at desc
  limit p_limit offset p_offset
$$;

create or replace function public.search_petty(
  p_user_id uuid,
  p_keyword text default '',
  p_start timestamptz default null,
  p_end timestamptz default null,
  p_limit integer default 25,
  p_offset integer default 0
)
returns table (
  id uuid, display_id text, transaction_at timestamptz, type public.petty_cash_type,
  amount numeric, remark text, running_balance numeric, source text, mode public.petty_cash_mode,
  total_count bigint
)
language sql
stable
security definer
set search_path = public
as $$
  with filtered as (
    select r.*
    from public.petty_cash_running r
    where r.user_id = p_user_id
      and (p_start is null or r.transaction_at >= p_start)
      and (p_end is null or r.transaction_at <= p_end)
      and (
        p_keyword = '' or p_keyword is null
        or r.display_id ilike '%' || p_keyword || '%'
        or r.remark ilike '%' || p_keyword || '%'
        or coalesce(r.reference, '') ilike '%' || p_keyword || '%'
      )
  )
  select f.id, f.display_id, f.transaction_at, f.type, f.amount, f.remark,
         f.running_balance, f.source, f.mode,
         count(*) over () as total_count
  from filtered f
  order by f.transaction_at desc
  limit p_limit offset p_offset
$$;

-- ----------------------------------------------------------------------------
-- global_search: dashboard search box across Sale + Petty (spec §23/§45).
-- ----------------------------------------------------------------------------
create or replace function public.global_search(p_user_id uuid, p_keyword text, p_limit integer default 10)
returns table (
  kind text, id uuid, label text, amount numeric, currency text, occurred_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  (
    select 'sale' as kind, s.id, s.customer_name || ' — ' || s.merchant as label,
           s.amount, s.currency::text, s.transaction_at as occurred_at
    from public.sales s
    where s.user_id = p_user_id and s.deleted_at is null
      and (s.trx_id ilike '%'||p_keyword||'%' or s.customer_name ilike '%'||p_keyword||'%'
           or s.merchant ilike '%'||p_keyword||'%' or s.remark ilike '%'||p_keyword||'%')
    order by s.transaction_at desc
    limit p_limit
  )
  union all
  (
    select 'petty' as kind, p.id, p.display_id || ' — ' || p.remark as label,
           p.amount, 'USD', p.transaction_at as occurred_at
    from public.petty_cash_transactions p
    where p.user_id = p_user_id and p.deleted_at is null
      and (p.display_id ilike '%'||p_keyword||'%' or p.remark ilike '%'||p_keyword||'%'
           or coalesce(p.reference,'') ilike '%'||p_keyword||'%')
    order by p.transaction_at desc
    limit p_limit
  )
$$;

-- ----------------------------------------------------------------------------
-- get_dashboard_summary: everything the Dashboard screen needs in one
-- round trip (spec §23), in the user's own timezone for the "today"
-- boundary.
-- ----------------------------------------------------------------------------
create or replace function public.get_dashboard_summary(p_user_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_tz text;
  v_today_start timestamptz;
  v_today_end timestamptz;
  v_week_start timestamptz;
  v_month_start timestamptz;
  v_now timestamptz := now();
  v_result jsonb;
begin
  select timezone into v_tz from public.app_users where id = p_user_id;
  v_tz := coalesce(v_tz, 'Asia/Phnom_Penh');

  v_today_start := date_trunc('day', v_now at time zone v_tz) at time zone v_tz;
  v_today_end := v_today_start + interval '1 day' - interval '1 microsecond';
  v_week_start := date_trunc('week', v_now at time zone v_tz) at time zone v_tz;
  v_month_start := date_trunc('month', v_now at time zone v_tz) at time zone v_tz;

  select jsonb_build_object(
    'today', to_jsonb(s_today.*),
    'week', to_jsonb(s_week.*),
    'month', to_jsonb(s_month.*),
    'petty_today', to_jsonb(p_today.*),
    'current_cash', public.current_petty_cash_balance(p_user_id),
    'low_cash_threshold', (select low_cash_alert_threshold from public.get_or_create_preferences(p_user_id)),
    'latest_sales', (
      select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
        select id, transaction_at, customer_name, amount, currency, merchant, trx_id
        from public.sales where user_id = p_user_id and deleted_at is null
        order by transaction_at desc limit 5
      ) x
    ),
    'latest_petty', (
      select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
        select id, display_id, transaction_at, type, amount, remark
        from public.petty_cash_transactions where user_id = p_user_id and deleted_at is null
        order by transaction_at desc limit 5
      ) x
    )
  ) into v_result
  from public.sale_summary(p_user_id, v_today_start, v_today_end) s_today,
       public.sale_summary(p_user_id, v_week_start, v_now) s_week,
       public.sale_summary(p_user_id, v_month_start, v_now) s_month,
       public.petty_cash_summary(p_user_id, v_today_start, v_today_end) p_today;

  return v_result;
end;
$$;
