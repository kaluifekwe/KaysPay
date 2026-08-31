import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, enforceRateLimit } from "../_shared/auth.ts";
import { getServiceCountries, isSmspvaConfigured } from "../_shared/smspva-client.ts";
import { FOREIGN_NUMBER_COUNTRIES, isPlausibleServiceCode, usdToNgnKobo, isWithinPriceCap } from "../_shared/smspva-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const CACHE_TTL_MS = 2 * 60 * 60 * 1000; // trust the cache for 2h

// Returns the countries that currently offer the chosen service, each with its
// live retail price. FAST path reads the smspva_price_cache row (refreshed
// every 15 min by smspva-catalog-sync) so this is a single DB read; falls back
// to a live SMSPVA fetch only if the cache is empty/stale. Read-only, no money.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isSmspvaConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const rate = await enforceRateLimit(adminClient(), "foreign_number_countries", user.id, 30, 60, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Please wait a moment and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const service = String(body?.service || "");
  if (!isPlausibleServiceCode(service)) return json({ success: false, error: "Unknown service" }, 400);

  const supabase = adminClient();

  // FAST PATH â€?cached prices.
  try {
    const { data: cache } = await supabase
      .from("smspva_price_cache")
      .select("data, updated_at")
      .eq("id", 1)
      .maybeSingle();
    const fresh = cache?.updated_at && Date.now() - new Date(cache.updated_at as string).getTime() < CACHE_TTL_MS;
    const cd = cache?.data as Record<string, Record<string, { p: number; c: number }>> | undefined;
    if (fresh && cd && Object.keys(cd).length > 0) {
      // Cache holds only IN-STOCK, under-cap combos, so anything present here is
      // genuinely available right now (as of the last ~15-min sync).
      const countries = FOREIGN_NUMBER_COUNTRIES
        .filter((c) => cd[c.id]?.[service] && typeof cd[c.id][service].p === "number")
        .map((c) => ({
          id: c.id,
          name: c.name,
          priceKobo: usdToNgnKobo(cd[c.id][service].p),
          available: cd[c.id][service].c,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return json({ success: true, countries });
    }
  } catch { /* fall through to live */ }

  // FALLBACK â€?live fetch (also covers the first run before the cron populates).
  try {
    const codes = FOREIGN_NUMBER_COUNTRIES.map((c) => c.id);
    const stock = await getServiceCountries(service, codes);
    const countries = FOREIGN_NUMBER_COUNTRIES
      .filter((c) => stock[c.id] && isWithinPriceCap(stock[c.id].cost))
      .map((c) => ({
        id: c.id,
        name: c.name,
        priceKobo: usdToNgnKobo(stock[c.id].cost),
        available: stock[c.id].count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return json({ success: true, countries });
  } catch {
    return json({ success: false, error: "Could not load available countries. Please try again." });
  }
});
