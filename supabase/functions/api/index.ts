// supabase/functions/api/index.ts
//
// Consolidated API endpoint for the Netlify frontend.
//
// Security invariants:
//   - Identity comes only from the verified application session token.
//   - The database is re-checked on every request so revoked/expired users and
//     changed roles take effect immediately.
//   - No request payload can choose a different user_id/actor id.
//   - Service-role database access is used only after those checks.

import { handleOptions, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { callRpc, getAdminClient } from "../_shared/supabaseAdmin.ts";
import { verifySessionToken } from "../_shared/session.ts";

interface ActionRequest {
  action: string;
  payload?: Record<string, unknown>;
}

interface CurrentAppUser {
  id: string;
  telegram_id: number;
  display_name: string;
  role: "ADMIN" | "USER";
  status: string;
  language: "en" | "kh";
  timezone: string;
  starts_at: string;
  expires_at: string | null;
}

function requireBearer(req: Request) {
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : null;
  if (!token) throw new Error("UNAUTHENTICATED");
  return verifySessionToken(token);
}

function asString(value: unknown, maxLength = 2000): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  return v.length > maxLength ? v.slice(0, maxLength) : v;
}

function asOptionalString(value: unknown, maxLength = 2000): string | null | undefined {
  if (value === undefined || value === null) return null;
  return asString(value, maxLength);
}

function asPositiveNumber(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error("INVALID_AMOUNT: amount must be positive");
  return n;
}

function asBoundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error("INVALID_LIMIT: value is outside the allowed range");
  return n;
}

function asUuid(value: unknown, fieldName: string): string {
  const s = asString(value, 100);
  if (!s || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) {
    throw new Error(`INVALID_${fieldName.toUpperCase()}: invalid UUID`);
  }
  return s;
}

function asDateOnly(value: unknown, fieldName: string): string {
  const s = asString(value, 20);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`INVALID_${fieldName.toUpperCase()}: expected YYYY-MM-DD`);
  const d = new Date(`${s}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`INVALID_${fieldName.toUpperCase()}: invalid date`);
  }
  return s;
}

function asTimezone(value: unknown, fieldName: string): string {
  const tz = asString(value, 100);
  if (!tz) throw new Error(`INVALID_${fieldName.toUpperCase()}: required`);
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz }).format();
  } catch {
    throw new Error(`INVALID_${fieldName.toUpperCase()}: invalid IANA timezone`);
  }
  return tz;
}

function asTelegramId(value: unknown): number {
  const n = typeof value === "number" ? value : Number(asString(value, 40));
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error("INVALID_TELEGRAM_ID: invalid Telegram ID");
  return n;
}

function asIsoDateTime(value: unknown, fieldName: string): string {
  const s = asString(value, 80);
  if (!s) throw new Error(`INVALID_${fieldName.toUpperCase()}: required`);
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`INVALID_${fieldName.toUpperCase()}: invalid date/time`);
  return d.toISOString();
}

function asUsagePeriod(value: unknown): string {
  const s = asString(value, 30) ?? "FOREVER";
  const allowed = new Set(["1_MONTH", "2_MONTHS", "3_MONTHS", "4_MONTHS", "5_MONTHS", "6_MONTHS", "1_YEAR", "FOREVER", "CUSTOM"]);
  if (!allowed.has(s)) throw new Error(`INVALID_USAGE_PERIOD: unsupported usage period`);
  return s;
}

function allowedPreferences(payload: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const textFields = [
    "shop_name_1", "shop_name_2", "shop_name_3",
    "expense_holder_1", "expense_holder_2", "expense_holder_3",
    "selected_gemini_model",
  ];
  for (const key of textFields) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      result[key] = asOptionalString(payload[key], key === "selected_gemini_model" ? 200 : 200);
    }
  }

  if (Object.prototype.hasOwnProperty.call(payload, "default_shop_name_index")) {
    result.default_shop_name_index = asBoundedInteger(payload.default_shop_name_index, 1, 1, 3);
  }
  if (Object.prototype.hasOwnProperty.call(payload, "default_expense_holder_index")) {
    result.default_expense_holder_index = asBoundedInteger(payload.default_expense_holder_index, 1, 1, 3);
  }

  if (Object.prototype.hasOwnProperty.call(payload, "khr_per_usd")) {
    const n = Number(payload.khr_per_usd);
    if (!Number.isFinite(n) || n <= 0 || n > 100000) throw new Error("INVALID_KHR_PER_USD: invalid rate");
    result.khr_per_usd = n;
  }
  if (Object.prototype.hasOwnProperty.call(payload, "low_cash_alert_threshold")) {
    const n = Number(payload.low_cash_alert_threshold);
    if (!Number.isFinite(n) || n < 0 || n > 100000000) throw new Error("INVALID_LOW_CASH_ALERT_THRESHOLD: invalid threshold");
    result.low_cash_alert_threshold = n;
  }
  return result;
}

Deno.serve(async (req: Request) => {
  const preflight = handleOptions(req);
  if (preflight) return preflight;
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let claims;
  try {
    claims = requireBearer(req);
  } catch {
    return errorResponse("Unauthenticated", 401);
  }

  let body: ActionRequest;
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  if (!body || typeof body.action !== "string" || !body.action.trim() || body.action.length > 80) {
    return errorResponse("Invalid action", 400);
  }
  const p = body.payload && typeof body.payload === "object" && !Array.isArray(body.payload)
    ? body.payload
    : {};

  let currentUser: CurrentAppUser;
  try {
    currentUser = await callRpc<CurrentAppUser>("require_current_app_user", { p_user_id: claims.app_user_id });
  } catch (e) {
    const message = (e as Error).message ?? "";
    if (message.startsWith("ACCESS_DENIED")) return errorResponse("Unauthenticated", 401);
    console.error("current-session validation failed:", message);
    return errorResponse("Internal error", 500);
  }

  const userId = currentUser.id;
  const role = currentUser.role;

  try {
    switch (body.action) {
      // -- Dashboard -----------------------------------------------------
      case "dashboard.summary":
        return jsonResponse(await callRpc("get_dashboard_summary", { p_user_id: userId }));

      case "dashboard.search":
        return jsonResponse(await callRpc("global_search", {
          p_user_id: userId,
          p_keyword: asString(p.keyword, 200) ?? "",
          p_limit: 20,
        }));

      // -- Sales ---------------------------------------------------------
      case "sales.list": {
        const limit = asBoundedInteger(p.limit, 25, 1, 100);
        const offset = asBoundedInteger(p.offset, 0, 0, 1000000);
        return jsonResponse(await callRpc("search_sales", {
          p_user_id: userId, p_keyword: asString(p.keyword, 200) ?? "",
          p_start: p.start ? asIsoDateTime(p.start, "start") : null,
          p_end: p.end ? asIsoDateTime(p.end, "end") : null,
          p_limit: limit, p_offset: offset,
        }));
      }

      case "sales.summary":
        return jsonResponse(await callRpc("sale_summary", {
          p_user_id: userId,
          p_start: p.start ? asIsoDateTime(p.start, "start") : new Date(0).toISOString(),
          p_end: p.end ? asIsoDateTime(p.end, "end") : new Date().toISOString(),
        }));

      case "sales.export": {
        const keyword = asString(p.keyword, 200) ?? "";
        const start = p.start ? asIsoDateTime(p.start, "start") : null;
        const end = p.end ? asIsoDateTime(p.end, "end") : null;
        const rows: Array<Record<string, unknown>> = [];
        const pageSize = 1000;
        const maxRows = 50_000;
        for (let offset = 0; offset < maxRows; offset += pageSize) {
          const page = await callRpc<Array<Record<string, unknown>>>("search_sales", {
            p_user_id: userId, p_keyword: keyword, p_start: start, p_end: end,
            p_limit: pageSize, p_offset: offset,
          });
          rows.push(...(page ?? []));
          if (!page || page.length < pageSize) break;
          if (Number(page[0]?.total_count ?? rows.length) <= rows.length) break;
        }
        const totalCount = Number(rows[0]?.total_count ?? rows.length);
        return jsonResponse({ rows, total_count: totalCount, truncated: totalCount > rows.length });
      }

      case "sales.create":
        return jsonResponse(await callRpc("create_sale", {
          p_user_id: userId,
          p_transaction_at: asIsoDateTime(p.transaction_at, "transaction_at"),
          p_customer_name: asString(p.customer_name, 200) ?? "-",
          p_amount: asPositiveNumber(p.amount),
          p_currency: p.currency,
          p_merchant: asString(p.merchant, 200) ?? "",
          p_remark: asString(p.remark, 1000) ?? "",
          p_trx_id: asString(p.trx_id, 200),
          p_source: "manual_missing",
          p_raw_text: "",
          p_actor_user_id: userId,
          p_user_timezone: currentUser.timezone,
        }));

      case "sales.update":
        return jsonResponse(await callRpc("update_sale", {
          p_user_id: userId,
          p_sale_id: asUuid(p.id, "sale_id"),
          p_customer_name: p.customer_name === undefined ? null : asString(p.customer_name, 200),
          p_amount: p.amount === undefined || p.amount === null || p.amount === "" ? null : asPositiveNumber(p.amount),
          p_currency: p.currency ?? null,
          p_merchant: p.merchant === undefined ? null : asString(p.merchant, 200),
          p_remark: p.remark === undefined ? null : asString(p.remark, 1000),
          p_actor_user_id: userId,
        }));

      case "sales.delete":
        return jsonResponse(await callRpc("delete_sale", {
          p_user_id: userId, p_sale_id: asUuid(p.id, "sale_id"), p_actor_user_id: userId,
          p_reason: asOptionalString(p.reason, 500),
        }));

      case "sales.topCustomers":
        return jsonResponse(await callRpc("top_customers", { p_user_id: userId, p_limit: asBoundedInteger(p.limit, 10, 1, 50) }));

      case "sales.topMerchants":
        return jsonResponse(await callRpc("top_merchants", { p_user_id: userId, p_limit: asBoundedInteger(p.limit, 10, 1, 50) }));

      // -- Petty Cash ----------------------------------------------------
      case "petty.list": {
        const limit = asBoundedInteger(p.limit, 25, 1, 100);
        const offset = asBoundedInteger(p.offset, 0, 0, 1000000);
        return jsonResponse(await callRpc("search_petty", {
          p_user_id: userId, p_keyword: asString(p.keyword, 200) ?? "",
          p_start: p.start ? asIsoDateTime(p.start, "start") : null,
          p_end: p.end ? asIsoDateTime(p.end, "end") : null,
          p_limit: limit, p_offset: offset,
        }));
      }

      case "petty.summary":
        return jsonResponse(await callRpc("petty_cash_summary", {
          p_user_id: userId,
          p_start: p.start ? asIsoDateTime(p.start, "start") : new Date(0).toISOString(),
          p_end: p.end ? asIsoDateTime(p.end, "end") : new Date().toISOString(),
        }));

      case "petty.balance":
        return jsonResponse({ current_cash: await callRpc("current_petty_cash_balance", { p_user_id: userId }) });

      case "petty.export": {
        const keyword = asString(p.keyword, 200) ?? "";
        const start = p.start ? asIsoDateTime(p.start, "start") : null;
        const end = p.end ? asIsoDateTime(p.end, "end") : null;
        const rows: Array<Record<string, unknown>> = [];
        const pageSize = 1000;
        const maxRows = 50_000;
        for (let offset = 0; offset < maxRows; offset += pageSize) {
          const page = await callRpc<Array<Record<string, unknown>>>("search_petty", {
            p_user_id: userId, p_keyword: keyword, p_start: start, p_end: end,
            p_limit: pageSize, p_offset: offset,
          });
          rows.push(...(page ?? []));
          if (!page || page.length < pageSize) break;
          if (Number(page[0]?.total_count ?? rows.length) <= rows.length) break;
        }
        const totalCount = Number(rows[0]?.total_count ?? rows.length);
        return jsonResponse({ rows, total_count: totalCount, truncated: totalCount > rows.length });
      }

      case "petty.create":
        return jsonResponse(await callRpc("create_petty_cash", {
          p_user_id: userId,
          p_type: p.type,
          p_amount: asPositiveNumber(p.amount),
          p_remark: asString(p.remark, 1000) ?? "",
          p_transaction_at: asIsoDateTime(p.transaction_at, "transaction_at"),
          p_reference: asOptionalString(p.reference, 200),
          p_mode: p.mode ?? "NORMAL",
          p_source: "Web",
          p_raw_text: "",
          p_created_by: userId,
          p_slip_job_id: null,
          p_user_timezone: currentUser.timezone,
        }));

      case "petty.update":
        return jsonResponse(await callRpc("update_petty_cash", {
          p_user_id: userId,
          p_display_id: asString(p.display_id, 40),
          p_amount: p.amount === undefined || p.amount === null || p.amount === "" ? null : asPositiveNumber(p.amount),
          p_remark: p.remark === undefined ? null : asString(p.remark, 1000),
          p_transaction_at: p.transaction_at ? asIsoDateTime(p.transaction_at, "transaction_at") : null,
          p_actor_user_id: userId,
          p_user_timezone: currentUser.timezone,
        }));

      case "petty.delete":
        return jsonResponse(await callRpc("delete_petty_cash", {
          p_user_id: userId,
          p_display_id: asString(p.display_id, 40),
          p_actor_user_id: userId,
          p_reason: asOptionalString(p.reason, 500),
        }));

      // -- Preferences --------------------------------------------------
      case "preferences.get":
        return jsonResponse(await callRpc("get_or_create_preferences", { p_user_id: userId }));

      case "preferences.update": {
        const safe = allowedPreferences(p);
        if (Object.keys(safe).length === 0) return jsonResponse(await callRpc("get_or_create_preferences", { p_user_id: userId }));
        const { data, error } = await getAdminClient()
          .from("user_preferences")
          .upsert({ user_id: userId, ...safe }, { onConflict: "user_id" })
          .select()
          .single();
        if (error) throw new Error(error.message);
        return jsonResponse(data);
      }

      case "profile.updateLanguage":
        if (p.language !== "en" && p.language !== "kh") throw new Error("INVALID_LANGUAGE: expected en or kh");
        return jsonResponse(await callRpc("update_own_profile", { p_user_id: userId, p_language: p.language }));

      // -- Gemini keys --------------------------------------------------
      case "gemini.listKeys": {
        const { data, error } = await getAdminClient()
          .from("gemini_api_key_refs")
          .select("id, label, masked_last4, enabled, priority, last_tested_at, last_test_ok, last_error, last_used_at")
          .eq("user_id", userId)
          .order("priority", { ascending: true });
        if (error) throw new Error(error.message);
        return jsonResponse(data);
      }

      case "gemini.addKey": {
        const rawKey = asString(p.raw_key, 500);
        if (!rawKey) throw new Error("INVALID_KEY: API key is required");
        return jsonResponse(await callRpc("add_gemini_key", {
          p_user_id: userId, p_label: asString(p.label, 100) ?? "Key", p_raw_key: rawKey,
          p_priority: asBoundedInteger(p.priority, 100, 0, 10000),
        }));
      }

      case "gemini.removeKey":
        await callRpc("remove_gemini_key", { p_key_ref_id: asUuid(p.key_ref_id, "key_ref_id"), p_user_id: userId });
        return jsonResponse({ ok: true });

      case "gemini.listModels": {
        const keyRefId = asUuid(p.key_ref_id, "key_ref_id");
        const plainKey = await callRpc<string>("get_gemini_key_plaintext_for_user", { p_key_ref_id: keyRefId, p_user_id: userId });
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(plainKey)}`);
        const json = await res.json();
        if (!res.ok) throw new Error(`GEMINI_HTTP_${res.status}: ${String(json?.error?.message ?? "ListModels failed").slice(0, 300)}`);
        // deno-lint-ignore no-explicit-any
        const models = (json.models ?? []) as any[];
        const usable = models
          .filter((m) => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes("generateContent"))
          .map((m) => (typeof m.name === "string" ? m.name.replace(/^models\//, "") : ""))
          .filter(Boolean);
        await callRpc("set_cached_gemini_models_for_user", { p_key_ref_id: keyRefId, p_user_id: userId, p_models: usable });
        return jsonResponse({ models: usable });
      }

      case "gemini.selectModel": {
        const model = asString(p.model, 200);
        if (!model) throw new Error("INVALID_MODEL: model is required");
        const { error } = await getAdminClient().from("user_preferences").update({ selected_gemini_model: model }).eq("user_id", userId);
        if (error) throw new Error(error.message);
        return jsonResponse({ ok: true });
      }

      // -- Admin --------------------------------------------------------
      case "admin.listUsers":
        if (role !== "ADMIN") return errorResponse("Forbidden", 403);
        return jsonResponse(await callRpc("admin_list_users", { p_actor_user_id: userId }));

      case "admin.createUser":
        if (role !== "ADMIN") return errorResponse("Forbidden", 403);
        {
          const roleValue = p.role ?? "USER";
          const languageValue = p.language ?? "en";
          const usagePeriod = asUsagePeriod(p.usage_period ?? "FOREVER");
          if (roleValue !== "ADMIN" && roleValue !== "USER") throw new Error("INVALID_ROLE: expected ADMIN or USER");
          if (languageValue !== "en" && languageValue !== "kh") throw new Error("INVALID_LANGUAGE: expected en or kh");
          const startDate = asDateOnly(p.start_date ?? new Date().toISOString().slice(0, 10), "start_date");
          const timezone = asTimezone(p.timezone ?? "Asia/Phnom_Penh", "timezone");
          const customExpiry = p.custom_expiry == null ? null : asDateOnly(p.custom_expiry, "custom_expiry");
          return jsonResponse(await callRpc("admin_create_user", {
            p_actor_user_id: userId, p_telegram_id: asTelegramId(p.telegram_id), p_display_name: asString(p.display_name, 200) ?? "",
            p_role: roleValue, p_start_date: startDate, p_usage_period: usagePeriod, p_custom_expiry: customExpiry,
            p_language: languageValue, p_timezone: timezone,
          }));
        }

      case "admin.setValidity":
        if (role !== "ADMIN") return errorResponse("Forbidden", 403);
        return jsonResponse(await callRpc("admin_set_validity", {
          p_actor_user_id: userId, p_target_user_id: asUuid(p.target_user_id, "target_user_id"), p_status: p.status ?? null,
          p_start_date: p.start_date == null ? null : asDateOnly(p.start_date, "start_date"),
          p_usage_period: p.usage_period == null ? null : asUsagePeriod(p.usage_period),
          p_custom_expiry: p.custom_expiry == null ? null : asDateOnly(p.custom_expiry, "custom_expiry"),
        }));

      case "admin.updateUser":
        if (role !== "ADMIN") return errorResponse("Forbidden", 403);
        return jsonResponse(await callRpc("admin_update_user", {
          p_actor_user_id: userId, p_target_user_id: asUuid(p.target_user_id, "target_user_id"),
          p_display_name: p.display_name === undefined ? null : asString(p.display_name, 200),
          p_language: p.language == null ? null : (p.language === "en" || p.language === "kh" ? p.language : (() => { throw new Error("INVALID_LANGUAGE: expected en or kh"); })()),
          p_timezone: p.timezone == null ? null : asTimezone(p.timezone, "timezone"),
        }));

      default:
        return errorResponse(`Unknown action: ${body.action}`, 400);
    }
  } catch (e) {
    const message = (e as Error).message ?? "Internal error";
    console.error(`api action "${body.action}" failed:`, message);
    if (message.startsWith("DUPLICATE_REFERENCE")) return errorResponse(message, 409, "DUPLICATE_REFERENCE");
    if (message.startsWith("NOT_FOUND")) return errorResponse(message, 404, "NOT_FOUND");
    if (message.startsWith("KEY_NOT_FOUND")) return errorResponse("Gemini key not found", 404, "KEY_NOT_FOUND");
    if (message.startsWith("INVALID_") || message.startsWith("MISSING_")) return errorResponse(message, 400, "VALIDATION_ERROR");
    if (message.startsWith("GEMINI_HTTP_")) return errorResponse(message, 502, "GEMINI_ERROR");
    if (message.startsWith("FORBIDDEN")) return errorResponse("Forbidden", 403);
    return errorResponse("Internal error", 500);
  }
});
