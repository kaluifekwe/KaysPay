import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, enforceRateLimit } from "../_shared/auth.ts";
import { isSmspvaConfigured } from "../_shared/smspva-client.ts";
import {
  FOREIGN_NUMBER_SERVICES,
  FOREIGN_NUMBER_COUNTRIES,
  usdToNgnKobo,
} from "../_shared/smspva-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Returns the curated service list, each with its cheapest available retail
// price ("from ₦X") computed from the price cache — so the service picker can
// show a starting price before the user drills in. Read-only, no money.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isSmspvaConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const supabase = adminClient();

  const rate = await enforceRateLimit(supabase, "foreign_number_services", user.id, 30, 60, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Please wait a moment and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  let cd: Record<string, Record<string, number>> | undefined;
  try {
    const { data: cache } = await supabase.from("smspva_price_cache").select("data").eq("id", 1).maybeSingle();
    cd = cache?.data as Record<string, Record<string, { p: number; c: number }>> | undefined;
  } catch { /* no cache yet — fromKobo will be null */ }

  // Cache holds only in-stock, under-cap combos, so the "from" price reflects
  // the cheapest country that's actually available for the service right now.
  const services = FOREIGN_NUMBER_SERVICES.map((s) => {
    let minUsd = Infinity;
    if (cd) {
      for (const c of FOREIGN_NUMBER_COUNTRIES) {
        const entry = cd[c.id]?.[s.id];
        if (entry && typeof entry.p === "number" && entry.p < minUsd) minUsd = entry.p;
      }
    }
    return { id: s.id, name: s.name, fromKobo: minUsd < Infinity ? usdToNgnKobo(minUsd) : null };
  });

  return json({ success: true, services });
});
