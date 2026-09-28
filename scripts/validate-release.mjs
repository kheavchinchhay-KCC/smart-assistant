#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
function loadTypeScript() {
  const candidates = [
    path.join(root, 'frontend', 'node_modules', 'typescript', 'lib', 'typescript.js'),
    '/usr/local/lib/node_modules/typescript/lib/typescript.js',
    '/usr/lib/node_modules/typescript/lib/typescript.js',
    path.resolve(path.dirname(process.execPath), '../lib/node_modules/typescript/lib/typescript.js'),
    '/usr/local/slides_js/node_modules/typescript/lib/typescript.js',
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return require(candidate);
  }
  return null;
}
const ts = loadTypeScript();
const failures = [];
const check = (condition, message) => { if (!condition) failures.push(message); };
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// Migration ordering and presence.
const migrationsDir = path.join(root, 'supabase', 'migrations');
const migrations = fs.readdirSync(migrationsDir).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
check(migrations.length === 18, `expected 18 migrations, found ${migrations.length}`);
check(migrations.every((n, i) => Number(n.slice(0, 4)) === i + 1), 'migrations are not sequential 0001..0018');
check(fs.existsSync(path.join(migrationsDir, '0018_security_hardening.sql')), '0018_security_hardening.sql missing');

// Netlify config: base=frontend means publish must be relative to frontend.
const netlify = read('netlify.toml');
check(/base\s*=\s*"frontend"/.test(netlify), 'Netlify base must be frontend');
check(/publish\s*=\s*"dist"/.test(netlify), 'Netlify publish must be dist when base is frontend');
check(!/publish\s*=\s*"frontend\/dist"/.test(netlify), 'old incorrect Netlify publish path remains');

// Frontend public-key configuration.
const env = read('frontend/.env.example');
check(/VITE_SUPABASE_PUBLISHABLE_KEY=/.test(env), 'publishable-key frontend env missing');
check(/VITE_SUPABASE_ANON_KEY=/.test(env), 'legacy anon-key fallback missing');
check(!/VITE_.*(SERVICE_ROLE|SECRET_KEY|JWT_SECRET|TELEGRAM_BOT_TOKEN)/i.test(env), 'frontend env example contains a server-only secret variable');

// Security regression scans.
const api = read('supabase/functions/api/index.ts');
const gemini = read('supabase/functions/telegram-webhook/gemini.ts');
check(!/upsert\(\{\s*user_id:\s*userId,\s*\.\.\.p\s*\}/.test(api), 'preferences payload can still override user_id');
check(!/get_gemini_key_plaintext\(/.test(gemini), 'old unscoped Gemini key retrieval is still called');
check(!/get_cached_gemini_models\(/.test(gemini), 'old unscoped Gemini cache helper is still called');
check(!/set_cached_gemini_models\(/.test(gemini), 'old unscoped Gemini cache helper is still called');
check(!/record_gemini_key_test\(\s*\{\s*p_key_ref_id:[^\n]*\}\s*\)/.test(gemini), 'Gemini test bookkeeping call is missing user scope');
check(api.includes('require_current_app_user'), 'API current-session user validation missing');
check(api.includes('get_gemini_key_plaintext_for_user'), 'API owner-scoped Gemini key retrieval missing');
const telegramAuth = read('supabase/functions/_shared/telegramAuth.ts');
check(telegramAuth.includes('authDate > nowSeconds + 300'), 'Telegram initData future-date replay guard missing');
const webhook = read('supabase/functions/telegram-webhook/index.ts');
check(webhook.includes('if (!WEBHOOK_SECRET)'), 'Telegram webhook does not fail closed when its secret is missing');

// i18n key parity.
const en = JSON.parse(read('frontend/src/i18n/en.json'));
const kh = JSON.parse(read('frontend/src/i18n/kh.json'));
const enKeys = Object.keys(en).sort();
const khKeys = Object.keys(kh).sort();
check(JSON.stringify(enKeys) === JSON.stringify(khKeys), 'EN/KH translation keys differ');

// Required implementation markers.
const exportFn = read('supabase/functions/telegram-webhook/export.ts');
check(exportFn.includes('pdf-lib@1.17.1'), 'Telegram PDF implementation missing pdf-lib');
check(exportFn.includes('@pdf-lib/fontkit@1.1.1'), 'Telegram PDF implementation missing fontkit');
check(exportFn.includes('NotoSansKhmer'), 'Telegram PDF implementation missing Khmer font');
check(exportFn.includes('MAX_EXPORT_ROWS = 50_000'), 'Telegram export row cap missing');
check(exportFn.includes('STORAGE_SAFE_LIMIT'), 'Telegram export storage safety cap missing');
check(fs.existsSync(path.join(root, 'frontend/src/lib/export.ts')), 'frontend export utility missing');
check(fs.existsSync(path.join(root, 'scripts/validate-release.mjs')), 'release validator missing');
check(/revoke all on all tables in schema public from anon, authenticated/i.test(read('supabase/migrations/0018_security_hardening.sql')), 'direct browser PostgREST table writes are not revoked');
check(/revoke all on all sequences in schema public from anon, authenticated/i.test(read('supabase/migrations/0018_security_hardening.sql')), 'direct browser sequence access is not revoked');

// Relative import resolution. This catches accidental file renames/missing source files
// that transpilation alone cannot detect. Package/URL imports are intentionally skipped.
function resolveSourceImport(fromRel, specifier) {
  if (!specifier.startsWith('.')) return null;
  const fromFile = path.join(root, fromRel);
  const base = path.resolve(path.dirname(fromFile), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
    path.join(base, 'index.js'),
    path.join(base, 'index.jsx'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ?? null;
}

function importResolutionCheck(rel) {
  const source = read(rel);
  const importPatterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of importPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith('.') && !resolveSourceImport(rel, specifier)) {
        failures.push(`${rel}: unresolved relative import ${specifier}`);
      }
    }
  }
}

// TypeScript/TSX syntax diagnostics (not semantic type-checking).
function syntaxCheck(rel) {
  if (!ts) return;
  const ext = path.extname(rel);
  const scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = path.join(root, rel);
  const source = fs.readFileSync(file, 'utf8');
  const result = ts.transpileModule(source, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
    transformers: undefined,
  });
  for (const d of result.diagnostics ?? []) {
    if (d.category === ts.DiagnosticCategory.Error) {
      const line = d.file?.getLineAndCharacterOfPosition(d.start ?? 0).line + 1;
      failures.push(`${rel}:${line}: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
    }
  }
  // The transpile API auto-detects JSX from extension only when fileName is supplied; keep scriptKind for intent/documentation.
  void scriptKind;
}

const roots = [
  path.join(root, 'frontend', 'src'),
  path.join(root, 'supabase', 'functions'),
  path.join(root, 'scripts'),
];
for (const dir of roots) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) { const rel = path.relative(root, full); importResolutionCheck(rel); syntaxCheck(rel); }
    }
  }
}

if (!ts) console.warn('WARNING: TypeScript compiler package was not found; TS/TSX syntax validation was skipped.');

if (failures.length) {
  console.error(`RELEASE VALIDATION FAILED (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log('RELEASE VALIDATION PASSED');
console.log(`- migrations: ${migrations.length} sequential (0001..0018)`);
console.log('- Netlify base/publish configuration');
console.log('- public/publishable key env configuration');
console.log('- Gemini ownership/security regression scans');
console.log('- EN/KH i18n key parity');
console.log('- required PDF/export implementation markers');
console.log(`- TypeScript/TSX syntax across frontend, Edge Functions, and scripts${ts ? '' : ' (skipped: compiler unavailable)'}`);
