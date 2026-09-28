// supabase/functions/telegram-webhook/parsers.ts
//
// Ported from legacy Transaction.gs (ABA/KHQR notification text parsing)
// and PettyCash.gs (free-text "<amount> <remark>" parsing), generalized
// with the same regex intent. NOTE: the ABA notification format varies
// slightly by bank app version — this was reconstructed from the
// patterns observed in the legacy source (a "Trx. ID:" label, a
// dollar-sign or KHR amount, and a payer name line) rather than copied
// byte-for-byte. Test against real forwarded ABA messages after
// deployment and adjust the regexes below if a real sample doesn't
// match (see STATUS.md "verify bank text parser against live samples").

export interface ParsedBankText {
  amount: number;
  currency: "USD" | "KHR";
  trxId: string;
  customerName: string;
}

const TRX_ID_PATTERNS = [
  /trx\.?\s*id\s*[:\-]?\s*([A-Za-z0-9]+)/i,
  /hash\s*[:\-]?\s*([A-Za-z0-9]+)/i,
  /ref(?:erence)?\.?\s*(?:no\.?|id)?\s*[:\-]?\s*([A-Za-z0-9]+)/i,
];

const USD_AMOUNT_PATTERN = /(?:USD|US\$|\$)\s*([\d,]+(?:\.\d{1,2})?)/i;
const KHR_AMOUNT_PATTERN = /([\d,]+(?:\.\d{1,2})?)\s*(?:KHR|\u17DB|RIEL)/i;

/**
 * Attempts to parse a forwarded ABA/KHQR payment notification.
 * Returns null if it doesn't look like a bank slip at all (caller falls
 * back to treating the message as a plain chat message / free text).
 */
export function parseBankText(raw: string): ParsedBankText | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  let trxId: string | null = null;
  for (const pattern of TRX_ID_PATTERNS) {
    const m = text.match(pattern);
    if (m) {
      trxId = m[1];
      break;
    }
  }
  if (!trxId) return null; // No Trx ID at all => not a bank notification.

  let amount: number | null = null;
  let currency: "USD" | "KHR" = "USD";

  const usdMatch = text.match(USD_AMOUNT_PATTERN);
  const khrMatch = text.match(KHR_AMOUNT_PATTERN);

  if (usdMatch) {
    amount = parseFloat(usdMatch[1].replace(/,/g, ""));
    currency = "USD";
  } else if (khrMatch) {
    amount = parseFloat(khrMatch[1].replace(/,/g, ""));
    currency = "KHR";
  }

  if (amount === null || Number.isNaN(amount) || amount <= 0) return null;

  // Best-effort payer name: first non-empty line that isn't the amount
  // or Trx ID line itself.
  const firstLine = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !TRX_ID_PATTERNS.some((p) => p.test(l)));
  const customerName = firstLine ? firstLine.replace(/paid you|sent you|received from/gi, "").trim() : "-";

  return { amount, currency, trxId, customerName: customerName || "-" };
}

/** "<amount> <remark...>" => { amount, remark }. Legacy PettyCash.gs parsePettyInput. */
export function parsePettyFreeText(raw: string): { amount: number; remark: string } | null {
  const text = (raw ?? "").trim();
  if (!text) return null;

  const m = text.match(/^([\d.]+)\s*(.*)$/);
  if (!m) return null;

  const amount = parseFloat(m[1]);
  if (Number.isNaN(amount) || amount <= 0) return null;

  const remark = m[2]?.trim() || "-";
  return { amount, remark };
}

export type DatePresetKey =
  | "TODAY" | "YESTERDAY" | "THIS_WEEK" | "LAST_WEEK" | "THIS_MONTH" | "LAST_MONTH";

/**
 * Resolves a date preset into [start, end] instants, evaluated in the
 * given IANA timezone (spec §46/§47 — never mix browser/Apps-Script/UTC
 * timezones; always resolve in the user's own configured timezone).
 * Week starts Monday, per spec §46 default.
 */
export function resolveDatePreset(preset: DatePresetKey, timezone: string, now = new Date()): { start: Date; end: Date } {
  const zonedParts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });

  const readParts = (instant: Date) => {
    const values = Object.fromEntries(
      zonedParts.formatToParts(instant).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
    );
    return {
      year: Number(values.year), month: Number(values.month), day: Number(values.day),
      hour: Number(values.hour), minute: Number(values.minute), second: Number(values.second),
    };
  };

  const toUtc = (year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): Date => {
    const desiredSecond = Date.UTC(year, month - 1, day, hour, minute, second);
    const desired = desiredSecond + millisecond;
    let candidate = desired;
    for (let i = 0; i < 6; i++) {
      const seen = readParts(new Date(candidate));
      const seenUtc = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
      const next = desiredSecond + (candidate - seenUtc);
      if (next === candidate) break;
      candidate = next;
    }
    return new Date(candidate);
  };

  const nowParts = readParts(now);
  // Use UTC as a calendar carrier; the fields represent wall-clock values in
  // `timezone`, so runtime/server timezone must never affect date arithmetic.
  const localNow = new Date(Date.UTC(
    nowParts.year, nowParts.month - 1, nowParts.day, nowParts.hour, nowParts.minute, nowParts.second, now.getMilliseconds(),
  ));
  const startOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0));
  const endOfDay = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999));
  const mondayOf = (d: Date): Date => {
    const day = d.getUTCDay();
    const diff = (day === 0 ? -6 : 1) - day;
    const monday = new Date(d);
    monday.setUTCDate(d.getUTCDate() + diff);
    return startOfDay(monday);
  };
  const utcFromWallDate = (d: Date, end: boolean) => toUtc(
    d.getFullYear(), d.getMonth() + 1, d.getDate(),
    end ? 23 : 0, end ? 59 : 0, end ? 59 : 0, end ? 999 : 0,
  );

  let startLocal: Date;
  let endLocal: Date;
  switch (preset) {
    case "TODAY":
      startLocal = startOfDay(localNow); endLocal = endOfDay(localNow); break;
    case "YESTERDAY": {
      const y = new Date(localNow); y.setUTCDate(y.getUTCDate() - 1);
      startLocal = startOfDay(y); endLocal = endOfDay(y); break;
    }
    case "THIS_WEEK":
      startLocal = mondayOf(localNow); endLocal = endOfDay(localNow); break;
    case "LAST_WEEK": {
      const thisMonday = mondayOf(localNow);
      const lastMonday = new Date(thisMonday); lastMonday.setUTCDate(lastMonday.getUTCDate() - 7);
      const lastSunday = new Date(thisMonday); lastSunday.setUTCDate(lastSunday.getUTCDate() - 1);
      startLocal = startOfDay(lastMonday); endLocal = endOfDay(lastSunday); break;
    }
    case "THIS_MONTH":
      startLocal = startOfDay(new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), 1)));
      endLocal = endOfDay(localNow); break;
    case "LAST_MONTH": {
      const firstThis = new Date(Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), 1));
      const lastPrev = new Date(firstThis); lastPrev.setUTCDate(0);
      startLocal = startOfDay(new Date(Date.UTC(lastPrev.getUTCFullYear(), lastPrev.getUTCMonth(), 1)));
      endLocal = endOfDay(lastPrev); break;
    }
    default:
      startLocal = startOfDay(localNow); endLocal = endOfDay(localNow);
  }

  return {
    start: utcFromWallDate(startLocal, false),
    end: utcFromWallDate(endLocal, true),
  };
}

export function labelForPreset(preset: DatePresetKey | "CUSTOM", lang: "en" | "kh" = "en"): string {
  const labels = {
    TODAY: "Today", YESTERDAY: "Yesterday", THIS_WEEK: "This week", LAST_WEEK: "Last week",
    THIS_MONTH: "This month", LAST_MONTH: "Last month", CUSTOM: "Custom range",
  };
  if (lang === "kh") {
    return {
      TODAY: "ថ្ងៃនេះ", YESTERDAY: "ម្សិលមិញ", THIS_WEEK: "សប្តាហ៍នេះ", LAST_WEEK: "សប្តាហ៍មុន",
      THIS_MONTH: "ខែនេះ", LAST_MONTH: "ខែមុន", CUSTOM: "ចន្លោះកាលបរិច្ឆេទ",
    }[preset];
  }
  return labels[preset];
}
