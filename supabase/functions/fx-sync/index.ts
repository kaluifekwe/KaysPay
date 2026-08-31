import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret } from "../_shared/auth.ts";
import { fetchWithTimeout } from "../_shared/provider-fetch.ts";

// Daily FX refresh (see the fx-sync-daily cron in migration 046). Pulls the
// current USD→NGN interbank rate from a free, no-key public feed and upserts
// it into `fx_rates` (pair 'USD_NGN'). eSIM pricing reads that row via
// getUsdNgnRate() and applies the FX buffer + margin on top.
//
// Cron-only: gated by the shared x-cron-secret (same as the reconcile sweeps).
// If the feed is unreachable or returns a bad value, we DON'T overwrite the
// existing row — stale-but-real beats zero/garbage, and pricing keeps working
// off the last good value (or the hardcoded fallback).
const FX_FEED_URL = "https://open.er-api.com/v6/latest/USD";

// Sanity band: reject anything obviously wrong so a bad feed response can't
// poison pricing. The naira has traded roughly ₦1,300–₦1,900/USD; keep a wide
// band so normal moves pass but a 0 / 13 / 160000 never lands.
const MIN_RATE = 800;
const MAX_RATE = 3000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);

  let rate: number;
  try {
    const res = await fetchWithTimeout(FX_FEED_URL, { headers: { Accept: "application/json" } }, 20_000);
    const data = await res.json();
    rate = Number(data?.rates?.NGN);
    if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) {
      return json({ updated: false, reason: "rate out of sane band or missing", got: data?.rates?.NGN ?? null });
    }
  } catch (e) {
    return json({ updated: false, reason: "feed unreachable", message: String((e as Error)?.message ?? e) });
  }

  const supabase = adminClient();
  const { error } = await supabase
    .from("fx_rates")
    .upsert({ pair: "USD_NGN", rate, source: "open.er-api.com", fetched_at: new Date().toISOString() });

  if (error) return json({ updated: false, reason: "db upsert failed", message: error.message }, 500);
  return json({ updated: true, pair: "USD_NGN", rate });
});
