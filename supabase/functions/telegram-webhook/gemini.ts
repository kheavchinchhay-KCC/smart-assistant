// supabase/functions/telegram-webhook/gemini.ts
//
// Replaces SlipOCR.gs's callGeminiWithFallback(), which looped through a
// hardcoded global key/model list. Here, keys and models are per-user
// (spec §9/§33): we pull the user's enabled Gemini keys in priority
// order (list_usable_gemini_keys), decrypt each one just-in-time via
// get_gemini_key_plaintext (service-role only, never sent to the
// frontend), and try the user's selected model first, falling back to
// the next enabled key if one fails or is rate-limited.
//
// The raw key is fetched, used for exactly one HTTP call, and then goes
// out of scope — it is never logged (spec §9: "Never log raw Gemini
// keys").

import { callRpc } from "../_shared/supabaseAdmin.ts";

const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Prompt intentionally does NOT hardcode any shop/holder name (spec §8) —
// classification against the user's configured names happens afterward
// in classify_slip_type() (0015_functions_slip_ops.sql). Gemini's own
// `slipType` guess is just one more signal fed into that function.
const OCR_PROMPT = `You are reading a Cambodian bank/payment transaction slip or screenshot (ABA, ACLEDA, Wing, KHQR, or similar). Extract the following fields as strict JSON, with no markdown fences and no commentary:
{
  "isBankSlip": boolean,           // false if this image is not a bank/payment slip at all
  "slipType": "SALE_TRANSACTION" | "EXPENSE" | "UNKNOWN",  // your best guess: money received (Sale) vs money paid out (Expense)
  "transactionDate": "M/D/YYYY",   // the transaction date exactly as shown, reformatted to M/D/YYYY
  "transactionTime": "HH:mm:ss",   // 24-hour time
  "name": string,                  // the customer/payer name if this looks like a Sale (money received)
  "expenseHolder": string,         // the account holder name if this looks like an Expense (money paid out)
  "amount": number,                // numeric amount only, no currency symbol or commas
  "currency": "USD" | "KHR",
  "merchant": string,              // shop/seller/payee name shown on the slip
  "remark": string,                // any memo/description line, or "-" if none
  "trxId": string                  // the transaction/reference/hash ID exactly as shown, or "" if not present
}
If a field is not present on the slip, use an empty string (or 0 for amount). Respond with ONLY the JSON object.`;

interface GeminiKeyRef {
  id: string;
  label: string;
  priority: number;
}

export interface OcrRunResult {
  isBankSlip: boolean;
  raw: Record<string, unknown>;
  modelUsed: string;
  keyRefId: string;
}

function decodeInlineImage(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

async function callGenerateContent(apiKey: string, model: string, imageB64: string, mimeType: string): Promise<Record<string, unknown>> {
  const url = `${GEMINI_API_BASE}/models/${model}:generateContent?key=${apiKey}`;
  const body = {
    contents: [
      {
        parts: [
          { text: OCR_PROMPT },
          { inline_data: { mime_type: mimeType, data: imageB64 } },
        ],
      },
    ],
    generationConfig: { temperature: 0, responseMimeType: "application/json" },
  };

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }

  const json = await res.json();
  const text: string | undefined = json?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Gemini returned no text content");

  try {
    return JSON.parse(text);
  } catch {
    // Model ignored responseMimeType and wrapped in fences — strip and retry once.
    const stripped = text.replace(/```json|```/g, "").trim();
    return JSON.parse(stripped);
  }
}

/**
 * Lists models available for a raw API key, filtered to ones usable for
 * this OCR workload (spec §10: image input + generateContent support,
 * not deprecated). Cached for 1 hour per key via
 * get/set_cached_gemini_models to avoid hammering the ListModels
 * endpoint on every slip (spec §51 "cached model lists where appropriate").
 */
export async function listAvailableModelsForKey(keyRefId: string, userId: string, apiKey: string): Promise<string[]> {
  const cached = await callRpc<string[] | null>("get_cached_gemini_models_for_user", { p_key_ref_id: keyRefId, p_user_id: userId });
  if (cached && Array.isArray(cached) && cached.length > 0) return cached;

  const res = await fetch(`${GEMINI_API_BASE}/models?key=${apiKey}`);
  if (!res.ok) throw new Error(`ListModels HTTP ${res.status}`);
  const json = await res.json();

  // deno-lint-ignore no-explicit-any
  const models = (json.models ?? []) as any[];
  const usable = models
    .filter((m) =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent") &&
      !/vision-only|deprecated/i.test(m.description ?? "") &&
      /flash|pro/i.test(m.name ?? ""))
    .map((m) => (m.name as string).replace(/^models\//, ""));

  await callRpc("set_cached_gemini_models_for_user", { p_key_ref_id: keyRefId, p_user_id: userId, p_models: usable });
  return usable;
}

/**
 * Runs OCR against the user's Gemini keys in priority order (spec §33
 * fallback logic: selected model + key 1, then key 2, ...). Records a
 * test/failure result against whichever key ultimately succeeded or was
 * tried, so Settings -> Preferences -> Gemini shows accurate
 * last-tested/last-error info without a separate "Test key" click.
 */
export async function runOcrWithFallback(
  userId: string,
  imageBytes: Uint8Array,
  mimeType: string,
  preferredModel: string | null,
): Promise<OcrRunResult> {
  const keys = await callRpc<GeminiKeyRef[]>("list_usable_gemini_keys", { p_user_id: userId });

  if (!keys || keys.length === 0) {
    throw new Error("NO_GEMINI_KEY: this user has no enabled Gemini API key configured");
  }

  const imageB64 = decodeInlineImage(imageBytes);
  let lastError: Error | null = null;

  for (const keyRef of keys) {
    let plainKey: string;
    try {
      plainKey = await callRpc<string>("get_gemini_key_plaintext_for_user", { p_key_ref_id: keyRef.id, p_user_id: userId });
    } catch (e) {
      lastError = e as Error;
      continue;
    }

    const modelsToTry = preferredModel
      ? [preferredModel, ...(await listAvailableModelsForKey(keyRef.id, userId, plainKey).catch(() => []))]
      : await listAvailableModelsForKey(keyRef.id, userId, plainKey).catch(() => ["gemini-2.5-flash"]);

    for (const model of [...new Set(modelsToTry)]) {
      try {
        const raw = await callGenerateContent(plainKey, model, imageB64, mimeType);
        await callRpc("record_gemini_key_test", { p_key_ref_id: keyRef.id, p_user_id: userId, p_ok: true, p_error: null });
        await callRpc("record_gemini_key_used", { p_key_ref_id: keyRef.id, p_user_id: userId });
        return { isBankSlip: !!raw.isBankSlip, raw, modelUsed: model, keyRefId: keyRef.id };
      } catch (e) {
        lastError = e as Error;
        // Keep trying the next model on this same key before moving to
        // the next key — a model-not-found error shouldn't burn the
        // whole key's cooldown.
        continue;
      }
    }

    // Every model failed for this key — record it as a failed test so
    // cooldown/failure_count advance (0005_gemini_api_key_refs.sql).
    await callRpc("record_gemini_key_test", {
      p_key_ref_id: keyRef.id, p_user_id: userId, p_ok: false, p_error: (lastError?.message ?? "unknown error").slice(0, 500),
    });
  }

  throw new Error(`ALL_KEYS_FAILED: ${lastError?.message ?? "no working Gemini key/model"}`);
}
