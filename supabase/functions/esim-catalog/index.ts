import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { fetchAiraloCatalog, isAiraloConfigured } from "../_shared/airalo-client.ts";
import { getUsdNgnRate, usdToNgnKobo } from "../_shared/esim-catalog.ts";

// Serves the full eSIM destination list (every Airalo country + every regional
// / worldwide package) from the esim_catalog cache table (migration 049), and
// stamps each country with a live "from" price (its cheapest plan, priced with
// today's FX).
//
// - Normal call (user): returns the cached list + live "from" prices. If the
//   cache is empty it does a one-time synchronous bootstrap fetch from Airalo.
// - Cron call with {"refresh": true} + x-cron-secret: re-pulls Airalo and
//   updates the cache (daily). Refresh is secret-gated so a user can't force
//   the heavy full-catalogue fetch on demand.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

// Each stored country carries its cheapest plan price in USD, so the list can
// show a "from ₦X" without a per-country live fetch.
function extractCountries(localRaw: any): { code: string; name: string; min_price_usd: number | null }[] {
  const seen = new Map<string, { code: string; name: string; min_price_usd: number | null }>();
  for (const c of localRaw?.data || []) {
    const code = String(c?.country_code || "").toUpperCase();
    const name = String(c?.title || "");
    if (!/^[A-Z]{2}$/.test(code) || !name) continue;

    let min = Infinity;
    for (const op of c?.operators || []) {
      for (const pkg of op?.packages || []) {
        const p = Number(pkg?.prices?.net_price?.USD ?? pkg?.net_price ?? pkg?.price);
        if (Number.isFinite(p) && p > 0 && p < min) min = p;
      }
    }
    const minUsd = min === Infinity ? null : min;

    const existing = seen.get(code);
    if (!existing) {
      seen.set(code, { code, name, min_price_usd: minUsd });
    } else if (minUsd != null && (existing.min_price_usd == null || minUsd < existing.min_price_usd)) {
      existing.min_price_usd = minUsd;
    }
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function extractRegions(globalRaw: any): { slug: string; name: string; worldwide: boolean }[] {
  const seen = new Map<string, { slug: string; name: string; worldwide: boolean }>();
  for (const c of globalRaw?.data || []) {
    const slug = String(c?.slug || "");
    const name = String(c?.title || "");
    if (slug && name && !seen.has(slug)) seen.set(slug, { slug, name, worldwide: slug === "world" });
  }
  return [...seen.values()].sort((a, b) =>
    a.worldwide === b.worldwide ? a.name.localeCompare(b.name) : a.worldwide ? 1 : -1,
  );
}

async function refresh(supabase: ReturnType<typeof adminClient>) {
  const [localRaw, globalRaw] = await Promise.all([
    fetchAiraloCatalog(supabase, "local"),
    fetchAiraloCatalog(supabase, "global"),
  ]);
  const countries = extractCountries(localRaw);
  const regions = extractRegions(globalRaw);
  if (countries.length === 0 && regions.length === 0) return null; // never clobber good data with a failed fetch
  await supabase
    .from("esim_catalog")
    .upsert({ id: 1, countries, regions, updated_at: new Date().toISOString() });
  return { countries, regions };
}

// Attach a live "from" naira price (cheapest plan × today's FX + margin) to
// each country, computed at read time so it always reflects the current rate.
function withFromPrices(countries: any[], rate: number) {
  return (countries || []).map((c) => ({
    code: c.code,
    name: c.name,
    from_kobo: c.min_price_usd != null ? usdToNgnKobo(Number(c.min_price_usd), rate) : null,
  }));
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const supabase = adminClient();

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    body = {};
  }

  // Cron-triggered daily refresh.
  if (body?.refresh === true) {
    if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
    if (!isAiraloConfigured()) return json({ refreshed: false, reason: "airalo not configured" });
    const res = await withJobLock(supabase, "esim-catalog-sync", () => refresh(supabase));
    return json({ refreshed: !!res && !("skipped" in (res as any)) });
  }

  const rate = await getUsdNgnRate(supabase);

  // User read.
  const { data: row } = await supabase
    .from("esim_catalog")
    .select("countries, regions")
    .eq("id", 1)
    .maybeSingle();

  if (row && Array.isArray(row.countries) && row.countries.length > 0) {
    return json({ success: true, countries: withFromPrices(row.countries, rate), regions: row.regions || [] });
  }

  // Cache empty → one-time bootstrap.
  if (isAiraloConfigured()) {
    const res = await withJobLock(supabase, "esim-catalog-sync", () => refresh(supabase));
    if (res && !("skipped" in (res as any))) {
      const r = res as { countries: any[]; regions: any[] };
      return json({ success: true, countries: withFromPrices(r.countries, rate), regions: r.regions });
    }
  }

  return json({ success: true, countries: [], regions: [] });
});
