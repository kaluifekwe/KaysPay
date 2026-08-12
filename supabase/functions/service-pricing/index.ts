import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser } from "../_shared/auth.ts";

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
// admin-pricing-controls.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (!(await getAuthUser(req))) return json({ error: "Unauthorized" }, 401);

  const supabase = adminClient();
  const { data, error } = await supabase.from("service_pricing").select("service_key, price_kobo");
  if (error) return json({ error: "Pricing temporarily unavailable" }, 503);

  const byKey = new Map((data ?? []).map((row) => [row.service_key, Number(row.price_kobo)]));
  const prices: Record<string, number> = {};
  for (const key of Object.keys(DEFAULTS_KOBO)) {
    const kobo = byKey.get(key);
    const validKobo = Number.isFinite(kobo) && (kobo as number) > 0 ? (kobo as number) : DEFAULTS_KOBO[key];
    prices[key] = validKobo / 100;
  }

  return json({ success: true, prices });
});
