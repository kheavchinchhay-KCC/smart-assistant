# Feature Matrix — Legacy Apps Script Bot → New Supabase/Netlify System

Legend for **Status**: ✅ Implemented in this drop · 🟡 Scaffolded/partial · ⬜ Not started (documented, next up)

| Legacy feature | Legacy file/function | New backend | New frontend | New Telegram flow | Status |
|---|---|---|---|---|---|
| Access control (Users sheet, ADMIN/STAFF, ACTIVE/BLOCKED) | `Utils.gs` `getUserAccess/isUserAllowed/isAdmin`, `Config.gs` | `app_users` table + `require_active_user()` SQL fn + edge fn `_shared/auth.ts` | Settings → Users (admin) | `/start` access check | ✅ |
| Bot state machine (per-chat conversation state) | `Utils.gs` `setState/getState`, `BotState` sheet | `bot_sessions` table (chat_id, state, temp_data jsonb) | n/a | Same states ported 1:1 | ✅ |
| Temp data per chat (`PropertiesService`) | `PettyCash.gs` `setTempData/getTempData` | `bot_sessions.temp_data` jsonb | n/a | Same | ✅ |
| `/start`, `/menu`, main menu keyboard | `Main.gs`, `Keyboard.gs` | telegram-webhook fn | Header shows validity | Ported, + language buttons + Open System button (§37) | ✅ |
| ABA/bank text parsing + duplicate Trx ID check | `Transaction.gs` | `parseBankText()` in `parsers.ts`; `sales` table + `transaction_reference_registry` unique constraint | Sale screen shows source=`bank_text` | Same regexes ported | ✅ |
| Missing (backdated) transaction manual entry | `MissingTransaction.gs`, `Main.gs` states `missing_trx_*` | `createSale()` RPC | "Add Missing Sale" | Same conversation flow ported | ✅ |
| Show missing transactions (paginated) | `MissingTransaction.gs` `sendMissingTransactionPage` | `listSales` filtered by `source in (manual_missing, slip)` | Sale list w/ filter | Same pagination via inline buttons | ✅ |
| Delete transaction w/ confirm | `DeleteTransaction.gs` | `deleteSale()` RPC + `audit_log` | Sale delete modal | Same confirm/cancel keyboard | ✅ |
| Petty Cash Cash In / Expense (free text amount+remark parse) | `PettyCash.gs` `parsePettyInput`, `savePettyCash` | `create_petty_cash()` RPC | Cash In / Expense forms | Same parser ported | ✅ |
| Petty Cash running balance & current cash | `PettyCash.gs` `sortPettyCash/recalculatePettyBalance` (physical resort + rewrite every row) | **Replaced**: `SUM(...) OVER (ORDER BY transaction_at, created_at, id)` window fn view `petty_cash_running` (§20, §67 acceptance test) | Petty Cash screen running balance column | n/a | ✅ |
| Petty Cash daily/weekly/monthly/date/date-range summary | `PettyCash.gs` `sendPettyDailySummary` etc. | `petty_cash_summary(user, start, end)` SQL fn | Petty Cash summary cards | Same menu buttons/labels | ✅ |
| Petty Cash missing (backdated) Cash In/Expense | `Main.gs` `petty_missing_*` states | Same RPC w/ custom date | "Add Missing" button | Ported | ✅ |
| Petty Cash edit / delete w/ confirm, low-cash alert | `PettyCash.gs` `editPettyCashById/deletePettyCashById/requestDeletePettyCash` | `update/delete_petty_cash()` RPCs, low-cash check reads live SUM | Edit/Delete modals | Inline confirm buttons ported | ✅ |
| Petty Cash history (last 10) | `PettyCash.gs` `sendPettyHistory` | `listPetty` paginated | Petty Cash table | `/history` equivalent button | ✅ |
| Legacy Petty ID format `PC000123` | `PettyCash.gs` `generatePettyId` | Preserved as **display id**, generated via `nextval` sequence with advisory lock (not row count) — real PK is uuid | Shown as "Petty ID" column | Same format in messages | ✅ |
| Reports: today/yesterday/weekly/monthly/date/date-range | `Reports.gs` `sendReport`, `sendReportRange` | `sale_summary(user,start,end)` SQL fn | Dashboard + Sale summary | Same report menu | ✅ |
| Customer / Trx / Merchant search, Top 10 customers/merchants | `Reports.gs` | `search_sales()`, `top_customers()`, `top_merchants()` SQL fns w/ indexes | Dashboard global search | Same search menu | ✅ |
| Dashboard sheet (daily aggregates, top10, revenue by day) | `DashBoard.gs` `refreshDashboard` | Replaced by live aggregate queries (`get_dashboard_summary` RPC) — no stored/staged sheet, no cron rebuild needed | Dashboard screen | n/a (web only) | ✅ |
| Nightly dashboard refresh trigger | `Trigger.gs`, `Automation.gs` `onEdit` | Not needed — dashboard is computed on read from indexed tables | n/a | n/a | ✅ (obsoleted by design, documented) |
| Photo upload → Gemini OCR → structured JSON | `SlipOCR.gs` `readSlipWithGemini`, prompt | `ocr.ts` in webhook fn, same prompt adapted to be **shop/holder-name driven** instead of hardcoded PHTEAS DECOR (§8) | Settings → Preferences → Shop/Holder names | Same "upload photo" trigger | ✅ |
| Gemini key/model fallback loop | `SlipOCR.gs` `callGeminiWithFallback` (hardcoded global keys/models) | Per-user `gemini_api_key_refs` (Vault-backed) × `listAvailableGeminiModels`, ordered fallback | Settings → Preferences → Gemini | n/a | ✅ |
| Slip Queue (READING/READY/FAILED/DUPLICATE/SAVED/CANCELLED) | `SlipQueue.gs` | `slip_jobs` table, same status enum | OCR job detail view (via "OCR details") | Inline buttons ported 1:1, callback_data shortened per §53 | ✅ |
| OCR Save-as-Expense / Save-as-Sale override (not forced) | `SlipQueue.gs` `saveQueuedSlipAs`, `buildSlipQueueKeyboard` | `saveSlipAsSale`/`saveSlipAsExpense` RPCs, final duplicate re-check at click time | OCR success view shows both buttons | Exact same 4-button layout | ✅ |
| Duplicate Trx/Ref ID across Sale **and** Expense | `SlipQueue.gs` `slipTransactionExistsAnywhere` (2 sequential sheet scans) | **Replaced**: single `transaction_reference_registry` table, `UNIQUE(user_id, normalized_reference)`, checked+inserted transactionally | n/a | Same duplicate message | ✅ |
| KHR→USD conversion for Expense | `SlipOCR.gs` `convertExpenseAmountToUSD`, `KHR_PER_USD=4000` | Per-user configurable rate in `user_preferences.khr_per_usd` (default 4000) — kept legacy default | Settings → Preferences | Same message format | ✅ |
| Expense holder normalization (hardcoded "KHEAV CHINCHHAY") | `SlipOCR.gs` `normalizeExpenseHolder` | Per-user configurable `expense_holder_1..3` w/ normalized/alias matching, not hardcoded (§8) | Settings → Preferences → Expense Holders | n/a | ✅ |
| Hardcoded merchant "PHTEAS DECOR" = Sale | `SlipOCR.gs` `getSlipType` | Per-user configurable `shop_name_1..3` (§8) | Settings → Preferences → Shop Names | n/a | ✅ |
| Edit OCR result via typed message | `SlipOCR.gs` `updateSlipTempDataFromText`, `updateExpenseSlipTempDataFromText` | `updateSlipJob` RPC, re-runs duplicate + validation | OCR job "Edit" (web) | Ported as bot free-text edit state | ✅ (bot flow ported; web OCR-specific edit remains separate scope) |
| CSV/PDF/XLSX export to Drive folder | `Export.gs` | **Replaced**: real `.xlsx` (ExcelJS) + `.pdf` (pdf-lib + Noto Sans Khmer fetched at runtime) → private Supabase Storage with expiring signed URLs | Sale/Petty CSV export + Print/PDF | Export menu: Sale/Petty → period → XLSX/PDF | ✅
| Admin-only gating scattered per command | Many files, repeated `isAdmin()` checks | Centralized `requireRole()` helper + RLS `is_admin()` | Admin-only routes guarded | Same per-command checks ported | ✅ |
| Timezone via `Session.getScriptTimeZone()` (Apps Script project TZ) | `Config.gs` | Explicit `app_users.timezone` (default `Asia/Phnom_Penh`), all date-preset math done server-side in that TZ | Header/date pickers | n/a | ✅ |
| Multi-user isolation | **Did not exist** — single global spreadsheet | `user_id` on every table + RLS + session-derived identity (never trust client `user_id`) | All screens scoped automatically | Telegram identity → app_users row | ✅ |
| Telegram Mini App "Open System" button + auth | **Did not exist** | `auth-telegram-miniapp` edge fn validates `initData` HMAC server-side (§16) | Header session bootstrap | `/start` shows blue Web App button | ✅ |
| Khmer/English language switching | Hardcoded Khmer strings inline everywhere | `app_users.language`, i18n JSON files, bot renders from same key set | Central i18n context, EN/KH toggle | Bot reads same `app_users.language` | ✅ |
| Audit log | **Did not exist** | `audit_log` table + triggers/RPC calls on sensitive actions | Admin diagnostics (future) | Logged silently | ✅ |
| Migration from Google Sheets (Transactions/PettyCash/Users) | **Did not exist** (destination, not source) | `import-legacy` edge fn / `scripts/import-from-sheets.ts`, CSV in → validate → `import_batches` audit | n/a (one-time admin tool) | n/a | 🟡 (schema + script skeleton done; full column-mapping validation next) |

## Remaining validation / separate scope
- Automated full end-to-end acceptance suite (§66) is not bundled yet; release validation covers static regression checks, while hosted-service smoke testing remains environment-specific.
- Legacy CSV import still needs a representative real source export to verify exact header/column mapping before a migration run.
- An admin diagnostics page and audit-log viewer UI remain separate scope; audit logging itself is implemented.
- Gemini model discovery now calls the live `ListModels` endpoint and keeps models that advertise `generateContent`. The Gemini Model resource does not expose a separate “image input” boolean, so OCR still uses the selected model and the existing fallback strategy; real-key smoke testing is recommended before depending on a nonstandard model.
