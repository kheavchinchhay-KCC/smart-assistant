// supabase/functions/_shared/cors.ts
//
// Applies to the Web App-facing functions (auth-telegram-miniapp, api/*).
// The Telegram webhook is never called from a browser, so it doesn't
// need CORS, but sharing one helper keeps things consistent.

const ALLOWED_ORIGIN = Deno.env.get("FRONTEND_ORIGIN") ?? "*";

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

export function handleOptions(req: Request): Response | null {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return null;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

export function errorResponse(message: string, status = 400, code?: string): Response {
  return jsonResponse({ error: { message, code: code ?? null } }, status);
}
