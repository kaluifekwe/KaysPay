import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { fetchAiraloCatalog, isAiraloConfigured } from "../_shared/airalo-client.ts";

// Serves the full eSIM destination list (every Airalo country + every regional
// / worldwide package) from the esim_catalog cache table (migration 049).
//
// - Normal call (user): returns the cached list. If the cache is empty it does
//   a one-time synchronous bootstrap fetch from Airalo.
// - Cron call with {"refresh": true} + x-cron-secret: re-pulls Airalo and
//   updates the cache (daily). Refresh is secret-gated so a user can't force
//   the heavy full-catalogue fetch on demand.

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

function extractCountries(localRaw: any): { code: string; name: string }[] {
  const seen = new Map<string, { code: string; name: string }>();
  for (const c of localRaw?.data || []) {
    const code = String(c?.country_code || "").toUpperCase();
    const name = String(c?.title || "");
    if (/^[A-Z]{2}$/.test(code) && name && !seen.has(code)) seen.set(code, { code, name });
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
  // worldwide plans last, everything else alphabetical.
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
  // Never overwrite a good cache with an empty/failed fetch.
  if (countries.length === 0 && regions.length === 0) return null;
  await supabase
    .from("esim_catalog")
    .upsert({ id: 1, countries, regions, updated_at: new Date().toISOString() });
  return { countries, regions };
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
    const refreshed = !!res && !("skipped" in (res as any));
    return json({ refreshed });
  }

  // User read.
  const { data: row } = await supabase
    .from("esim_catalog")
    .select("countries, regions")
    .eq("id", 1)
    .maybeSingle();

  if (row && Array.isArray(row.countries) && row.countries.length > 0) {
    return json({ success: true, countries: row.countries, regions: row.regions || [] });
  }

  // Cache empty → one-time bootstrap.
  if (isAiraloConfigured()) {
    const res = await withJobLock(supabase, "esim-catalog-sync", () => refresh(supabase));
    if (res && !("skipped" in (res as any))) {
      const r = res as { countries: unknown[]; regions: unknown[] };
      return json({ success: true, countries: r.countries, regions: r.regions });
    }
  }

  // Fallback: empty — the client falls back to its built-in country list.
  return json({ success: true, countries: [], regions: [] });
});
