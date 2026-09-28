# Release status — final deployment-hardening patch

This tree is the deployment candidate based on the uploaded `smart-assistant-supabase.zip`. It includes one additive migration, `supabase/migrations/0018_security_hardening.sql`, and focused frontend/Edge Function hardening. Older migrations are left unchanged.

## Fixed in this patch

- Netlify: `base = "frontend"`, `publish = "dist"`; Node pinned to 24.12.0.
- Edge gateway JWT verification is disabled for the three custom-auth/webhook functions; each endpoint performs its own trust-boundary validation.
- Custom application sessions use `APP_SESSION_SECRET` instead of the reserved `SUPABASE_JWT_SECRET`.
- Web Sale/Petty Cash: edit, delete/create, custom date range, timezone-aware dates, server-side totals, CSV export, and browser Print/PDF.
- CSV: UTF-8 BOM plus formula-injection protection.
- Telegram export: XLSX with ExcelJS; PDF with pdf-lib + fontkit + runtime Noto Sans Khmer; A4 landscape pagination and repeated headers.
- Export volume: 50,000-row cap with explicit “narrow the date range” handling; generated files are kept below the private Storage bucket limit.
- Telegram Bot API failures are surfaced instead of being silently treated as successful calls.
- Web API validates the current database user on every request, so blocked/inactive/expired users lose access immediately even if an old session token remains in the browser.
- Preferences writes use a whitelist and always use the authenticated server-side user ID.
- Gemini key retrieval, model cache, and key status bookkeeping are owner-scoped; model cache has RLS.
- New Supabase secret-key environment names are supported with the legacy service-role fallback.
- Admin API input validation covers IDs, roles, language, dates, timezone, Telegram IDs, and usage periods.
- Telegram Mini App initData rejects future-dated payloads beyond a small clock-skew allowance.
- Telegram webhook authentication now fails closed when `TELEGRAM_WEBHOOK_SECRET` is missing.
- Browser PostgREST table/sequence privileges are revoked so the UI cannot bypass server-side business rules.
- EN/KH UI labels used by the repaired export/report flows are localized.

## What is validated locally

- Release validator passes.
- Migration filenames are sequential `0001..0018`.
- Netlify config and public-key environment names are checked.
- Security regression scans pass for preferences and unscoped Gemini helper calls.
- EN/KH translation keys match.
- All TypeScript/TSX files pass syntax transpilation in the available compiler environment.

## What cannot be certified from this ZIP alone

A production deployment still needs one real environment smoke test against the project’s hosted Supabase, Telegram Bot API, Gemini API key, and Netlify site. This is an external-integration validation, not a code change.

Before production, run a fresh dependency install/build and apply the new migration once. Then verify: Telegram `/start` → Open System, web login, Sale create/edit/delete, Petty Cash create/edit/delete, OCR save-as Sale/Expense, Gemini model refresh/use, CSV/Print, Telegram XLSX/PDF export, and access revocation.
