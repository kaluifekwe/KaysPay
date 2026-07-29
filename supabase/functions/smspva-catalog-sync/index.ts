import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret } from "../_shared/auth.ts";
import { getCountryPrices, getAvailability, isSmspvaConfigured } from "../_shared/smspva-client.ts";
import { FOREIGN_NUMBER_COUNTRIES, FOREIGN_NUMBER_SERVICES, isWithinPriceCap } from "../_shared/smspva-catalog.ts";

// Refreshes the smspva_price_cache (see migration 055) with REAL STOCK, so the
// "pick a country" screen only ever shows countries that actually have numbers
// available — not just ones the provider theoretically offers. Stores
// {country: {serviceCode: {p: usdPrice, c: count}}} for our curated services,
// keeping only IN-STOCK (count > 0), under-cap combos. Cron-only (x-cron-secret).
//
// Two phases so we don't waste count-calls: (1) fetch prices per country in one
// call each, keep only our under-cap services; (2) check live stock for exactly
// those (country, service) pairs. Both run in small concurrency-limited batches
// because SMSPVA rate-limits bursts.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function inBatches<T>(items: T[], size: number, fn: (x: T) => Promise<void>): Promise<void> {
  for (let i = 0; i < items.length; i += size) {
    await Promise.all(items.slice(i, i + size).map(fn));
    if (i + size < items.length) await new Promise((r) => setTimeout(r, 120));
  }
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  if (!isSmspvaConfigured()) return json({ synced: false, reason: "smspva not configured" });

  const supabase = adminClient();
  const codes = FOREIGN_NUMBER_COUNTRIES.map((c) => c.id);
  const ourSet = new Set(FOREIGN_NUMBER_SERVICES.map((s) => s.id));

  // Phase 1: prices per country → keep only our curated, under-cap services.
  const priceMap: Record<string, Record<string, number>> = {};
  await inBatches(codes, 10, async (c) => {
    try {
      const prices = await getCountryPrices(c);
      const kept: Record<string, number> = {};
      for (const [svc, p] of Object.entries(prices)) {
        if (ourSet.has(svc) && isWithinPriceCap(p)) kept[svc] = p;
      }
      if (Object.keys(kept).length > 0) priceMap[c] = kept;
    } catch { /* skip */ }
  });

  // Phase 2: live stock for each (country, service) that has a valid price.
  const tasks: { c: string; s: string; p: number }[] = [];
  for (const [c, svcs] of Object.entries(priceMap)) {
    for (const [s, p] of Object.entries(svcs)) tasks.push({ c, s, p });
  }
  const data: Record<string, Record<string, { p: number; c: number }>> = {};
  await inBatches(tasks, 10, async (t) => {
    try {
      const count = await getAvailability(t.s, t.c);
      if (count > 0) {
        if (!data[t.c]) data[t.c] = {};
        data[t.c][t.s] = { p: t.p, c: count };
      }
    } catch { /* skip */ }
  });

  const countriesWithStock = Object.keys(data).length;
  // Don't clobber a good cache with an empty run (e.g. rate-limited).
  if (countriesWithStock === 0) return json({ synced: false, reason: "no in-stock data this run" });

  await supabase.from("smspva_price_cache").upsert({ id: 1, data, updated_at: new Date().toISOString() });
  return json({ synced: true, countries: countriesWithStock, checked: tasks.length });
});
