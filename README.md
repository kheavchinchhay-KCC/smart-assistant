# Final release notes

Last worked on: final hardening patch for the uploaded `smart-assistant-supabase.zip`.
The patch fixes the production blockers found during review and keeps the schema
change additive in `supabase/migrations/0018_security_hardening.sql`.

## Included in this final patch

- Netlify config corrected to `base = frontend`, `publish = dist`.
- Frontend Sale and Petty Cash edit workflows are wired to backend RPCs.
- Sale/Petty custom date ranges are supported and resolved in the user timezone.
- Sale/Petty CSV export is implemented with UTF-8 BOM and formula-injection protection.
- Sale/Petty Print/PDF is implemented as a browser print view; the print window is
  opened synchronously to avoid popup-blocker failures after async API calls.
- Telegram XLSX export is fully generated with ExcelJS.
- Telegram PDF export is implemented with pdf-lib + fontkit and a runtime-fetched
  Noto Sans Khmer font, with A4 landscape pagination and repeating table headers.
  The font is not stored in the repository.
- Telegram Bot API failures now throw instead of being silently treated as success.
- Web API re-validates the current database user on every request, so deactivated,
  blocked, or expired users lose access immediately even with an old session JWT.
- Preferences updates whitelist writable fields and always force the authenticated
  user id server-side.
- Gemini Vault/key-cache/test helpers are owner-scoped; the Gemini model cache has RLS.
- Direct browser PostgREST writes to application tables are revoked; protected writes must pass through the hardened API/RPC path.
- Server-side Supabase client supports the newer secret-key env names with a legacy
  `SUPABASE_SERVICE_ROLE_KEY` compatibility fallback.
- Admin API inputs have explicit validation for UUIDs, dates, roles, languages,
  timezones, Telegram IDs, and usage periods.

## Still requires live verification

No sandbox can honestly certify a hosted deployment without access to the real
Supabase project, Telegram bot, Gemini key, and Netlify site. The remaining live
smoke test is: push migration 0018, deploy the three Edge Functions, deploy the
frontend, set the exact public/server environment variables, verify the Telegram
webhook, and run Sale/Petty create-edit-delete, OCR, exports, and login/logout
from a real Telegram account.

The legacy CSV importer and OCR typed-edit flow still require representative real
inputs to validate field mappings; those are separate from the production blockers
fixed in this patch. Automated full end-to-end acceptance tests, an admin diagnostics
page, and an audit-log viewer remain separate scope.

## Final local validation performed on the patched tree

- Static TypeScript/TSX syntax validation across the changed TS/TSX sources.
- JSON parse validation for frontend EN/KH dictionaries.
- Netlify config and required files checked by the release validator.
- Scan confirms the old insecure Gemini helper call names are not used by Edge Functions.
- Scan confirms the API no longer accepts a client-supplied `user_id` for preferences.
- Diff manifest generated against the uploaded baseline ZIP.

### Re-run before production

```bash
cd frontend
npm ci
npm run build
cd ..
node scripts/validate-release.mjs
```

Then apply migration `0018_security_hardening.sql` once with the normal Supabase migration workflow and deploy the `api`, `auth-telegram-miniapp`, and `telegram-webhook` Edge Functions.
