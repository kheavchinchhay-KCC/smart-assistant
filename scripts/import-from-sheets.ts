// scripts/import-from-sheets.ts
//
// One-time migration tool (spec §55-56). Run locally with Deno, NOT as
// an Edge Function (it needs long-running access and is an admin-only,
// occasional operation).
//
// Usage:
//   deno run --allow-net --allow-env --allow-read scripts/import-from-sheets.ts \
//     --users ./export/Users.csv \
//     --sales ./export/Transactions.csv \
//     --petty ./export/PettyCash.csv \
//     --telegram-id-for-import 123456789
//
// Requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment
// (same values as supabase/.env — see README "Migration from Google
// Sheets"). All rows for Sale/PettyCash are imported under the single
// app_users row matching --telegram-id-for-import (create that user via
// the admin UI first) since the legacy spreadsheet had no multi-user
// concept.
//
// STATUS: functional first pass, NOT yet run against a real production
// export (see STATUS.md). Validate column headers against your actual
// CSV before trusting the numbers — legacy sheet column order is
// documented in FEATURE_MATRIX.md sections 2-3, but re-check against the
// live spreadsheet since it "has already evolved through multiple fixes"
// per the original build spec.

import { createClient } from "npm:@supabase/supabase-js@2";
import { parse } from "npm:csv-parse@5/sync";

interface ImportError { row: number; sheet: string; reason: string; raw: unknown }

const args = parseArgs(Deno.args);
const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
if (!supabaseUrl || !serviceKey) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the environment first.");
  Deno.exit(1);
}
const supabase = createClient(supabaseUrl, serviceKey);

const errors: ImportError[] = [];
const importBatchId = crypto.randomUUID();
let saleOk = 0, saleFail = 0, pettyOk = 0, pettyFail = 0, userOk = 0, userFail = 0;

async function main() {
  console.log(`Import batch: ${importBatchId}`);

  if (args.users) {
    await importUsers(args.users);
  }

  let targetUserId: string | null = null;
  if (args["telegram-id-for-import"]) {
    const { data } = await supabase
      .from("app_users")
      .select("id")
      .eq("telegram_id", parseInt(args["telegram-id-for-import"], 10))
      .maybeSingle();
    targetUserId = data?.id ?? null;
    if (!targetUserId) {
      console.error("--telegram-id-for-import did not match any app_users row. Create that user first (Settings -> Users) and retry.");
      Deno.exit(1);
    }
  }

  if (args.sales && targetUserId) {
    await importSales(args.sales, targetUserId);
  }
  if (args.petty && targetUserId) {
    await importPetty(args.petty, targetUserId);
  }

  console.log("\n=== Import summary ===");
  console.log(`Users:   ${userOk} imported, ${userFail} failed`);
  console.log(`Sales:   ${saleOk} imported, ${saleFail} failed`);
  console.log(`Petty:   ${pettyOk} imported, ${pettyFail} failed`);
  console.log(`Errors:  ${errors.length}`);

  if (errors.length > 0) {
    const reportPath = `./import-errors-${importBatchId}.json`;
    await Deno.writeTextFile(reportPath, JSON.stringify(errors, null, 2));
    console.log(`Error report written to ${reportPath} — no row was silently discarded (spec §55).`);
  }
}

async function importUsers(path: string) {
  const rows = parseCsv(path);
  for (const [i, row] of rows.entries()) {
    try {
      const { error } = await supabase.from("app_users").insert({
        telegram_id: parseInt(row.telegram_id, 10),
        display_name: row.display_name ?? "",
        role: (row.role ?? "USER").toUpperCase(),
        status: (row.status ?? "ACTIVE").toUpperCase(),
        starts_at: row.starts_at || new Date().toISOString().slice(0, 10),
        expires_at: row.expires_at || null,
        language: (row.language ?? "en").toLowerCase(),
        timezone: row.timezone || "Asia/Phnom_Penh",
      });
      if (error) throw new Error(error.message);
      userOk++;
    } catch (e) {
      userFail++;
      errors.push({ row: i, sheet: "Users", reason: (e as Error).message, raw: row });
    }
  }
}

async function importSales(path: string, userId: string) {
  const rows = parseCsv(path);
  for (const [i, row] of rows.entries()) {
    try {
      const trxId = (row.trx_id ?? row["Trx ID"] ?? "").trim();
      if (!trxId) throw new Error("missing Trx ID — Sale cannot be imported without one");

      const transactionAt = combineDateTime(row.date ?? row.Date, row.time ?? row.Time);
      const amount = parseFloat(row.amount ?? row.Amount);
      if (Number.isNaN(amount) || amount <= 0) throw new Error(`invalid amount: ${row.amount}`);

      const { data: sale, error } = await supabase.rpc("create_sale", {
        p_user_id: userId,
        p_transaction_at: transactionAt.toISOString(),
        p_customer_name: row.name ?? row.Name ?? "-",
        p_amount: amount,
        p_currency: (row.currency ?? row.Currency ?? "USD").toUpperCase(),
        p_merchant: row.merchant ?? row.Merchant ?? "",
        p_remark: row.remark ?? row.Remark ?? "",
        p_trx_id: trxId,
        p_source: "manual_missing",
        p_raw_text: row.raw_source ?? row["Raw source text"] ?? "",
        p_actor_user_id: userId,
      });
      if (error) throw new Error(error.message);
      void sale;
      saleOk++;
    } catch (e) {
      saleFail++;
      errors.push({ row: i, sheet: "Transactions", reason: (e as Error).message, raw: row });
    }
  }
}

async function importPetty(path: string, userId: string) {
  const rows = parseCsv(path);
  let maxNumber = 0;

  for (const [i, row] of rows.entries()) {
    try {
      const legacyId: string = (row.petty_id ?? row["Petty ID"] ?? "").trim();
      const numMatch = legacyId.match(/(\d+)$/);
      const legacyNumber = numMatch ? parseInt(numMatch[1], 10) : null;

      const type = (row.type ?? row.Type ?? "").toUpperCase() === "IN" ? "IN" : "OUT";
      const amount = parseFloat(row.amount ?? row.Amount);
      if (Number.isNaN(amount) || amount <= 0) throw new Error(`invalid amount: ${row.amount}`);

      const transactionAt = combineDateTime(row.date ?? row.Date, row.time ?? row.Time);
      const reference = row.reference ?? null;

      // Insert directly (bypassing create_petty_cash's own display-id
      // generator) so the legacy PC###### id is preserved exactly, per
      // spec §56. The registry row is inserted first if a reference is
      // present, same invariant create_petty_cash() itself keeps.
      const refNorm = reference ? String(reference).trim().toUpperCase() : null;
      if (refNorm) {
        await supabase.from("transaction_reference_registry").insert({
          user_id: userId, normalized_reference: refNorm, source_type: "petty_cash", source_record_id: crypto.randomUUID(),
        }).then(() => {}, () => { throw new Error(`duplicate reference on import: ${reference}`); });
      }

      const local = transactionAt;
      const { error } = await supabase.from("petty_cash_transactions").insert({
        user_id: userId,
        display_id: legacyId || `PC${String(i + 1).padStart(6, "0")}`,
        transaction_at: transactionAt.toISOString(),
        date_local: local.toISOString().slice(0, 10),
        time_local: local.toISOString().slice(11, 19),
        type,
        amount,
        remark: row.remark ?? row.Remark ?? "",
        reference,
        reference_normalized: refNorm,
        mode: "NORMAL",
        source: row.source ?? row.Source ?? "Import",
        raw_text: row.raw_input ?? row["Raw input"] ?? "",
        created_by: userId,
      });
      if (error) throw new Error(error.message);

      if (legacyNumber && legacyNumber > maxNumber) maxNumber = legacyNumber;
      pettyOk++;
    } catch (e) {
      pettyFail++;
      errors.push({ row: i, sheet: "PettyCash", reason: (e as Error).message, raw: row });
    }
  }

  if (maxNumber > 0) {
    await supabase.from("petty_cash_id_counters").upsert({ user_id: userId, next_number: maxNumber + 1 });
    console.log(`Petty ID counter for this user set to continue from PC${String(maxNumber + 1).padStart(6, "0")} (spec §56: never reuse legacy IDs).`);
  }
}

function combineDateTime(dateStr: string, timeStr: string): Date {
  if (!dateStr) throw new Error("missing date");
  const d = new Date(`${dateStr}T${timeStr || "00:00:00"}`);
  if (Number.isNaN(d.getTime())) throw new Error(`unparseable date/time: ${dateStr} ${timeStr}`);
  return d;
}

function parseCsv(path: string): Record<string, string>[] {
  const text = Deno.readTextFileSync(path);
  return parse(text, { columns: true, skip_empty_lines: true, trim: true });
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      out[key] = argv[i + 1];
      i++;
    }
  }
  return out;
}

await main();
