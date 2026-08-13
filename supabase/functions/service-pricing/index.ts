import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, isServiceEnabled } from "../_shared/auth.ts";

// Same defaults as each identity function's own hardcoded fallback (see
// _shared/service-pricing.ts) — kept in sync manually since these live in
// separate runtimes; a mismatch here only affects what price the app
// *displays* before charging, never what it's actually charged (each
// identity function re-derives its own authoritative price server-side).
const DEFAULTS_KOBO: Record<string, number> = {
  nin_verify_regular: 50000,
  nin_verify_card: 70000,
  nin_modification: 1800000,
  nin_validation: 800000,
  bvn_verify_regular: 50000,
  bvn_verify_card: 70000,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Read-only, any logged-in user (not an admin-only endpoint) — lets the app
// show the current NIN/BVN price before charging instead of a hardcoded
// constant that goes stale the moment an admin changes something via
// admin-pricing-controls. Also surfaces the nin_modification kill switch
// (migration 113) so the app can hide the whole Modification tab the moment
// it's disabled, rather than only rejecting the submit — nin-modify and
// nin-validate still enforce this server-side regardless of what the app
// shows, so this is a UX read, not the actual security boundary.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (!(await getAuthUser(req))) return json({ error: "Unauthorized" }, 401);

  const supabase = adminClient();
  const [{ data, error }, modificationEnabled, { data: feeRow }] = await Promise.all([
    supabase.from("service_pricing").select("service_key, price_kobo"),
    isServiceEnabled(supabase, "nin_modification"),
    supabase.from("electricity_fee_config").select("fee_kobo").eq("id", true).maybeSingle(),
  ]);
  if (error) return json({ error: "Pricing temporarily unavailable" }, 503);

  const byKey = new Map((data ?? []).map((row) => [row.service_key, Number(row.price_kobo)]));
  const prices: Record<string, number> = {};
  for (const key of Object.keys(DEFAULTS_KOBO)) {
    const kobo = byKey.get(key);
    const validKobo = Number.isFinite(kobo) && (kobo as number) > 0 ? (kobo as number) : DEFAULTS_KOBO[key];
    prices[key] = validKobo / 100;
  }
  const electricityFeeNaira = (Number(feeRow?.fee_kobo) || 0) / 100;

  return json({
    success: true,
    prices,
    nin_modification_enabled: modificationEnabled,
    electricity_fee: electricityFeeNaira,
  });
});
