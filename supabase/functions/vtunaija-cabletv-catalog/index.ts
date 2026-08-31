import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { callVTUNaija } from "../_shared/vtunaija-client.ts";

const PROVIDERS = ["gotv", "dstv", "startimes"] as const;

// VTUnaija's catalog uses uppercase names; SHOWMAX is deliberately excluded â€?// not a supported TVServiceProvider in this app.
const PROVIDER_NAME_MAP: Record<string, typeof PROVIDERS[number]> = {
  GOTV: "gotv",
  DSTV: "dstv",
  STARTIMES: "startimes",
};

class CatalogSyncError extends Error {
  constructor(public readonly safeCode: "PROVIDER_FETCH_FAILED" | "SNAPSHOT_INVALID" | "DATABASE_SAVE_FAILED") {
    super(safeCode);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json", "Cache-Control": "private, max-age=60" },
  });
}

async function fetchCatalog() {
  let payload: any;
  try {
    payload = await callVTUNaija("/listcabletvplans/", {});
  } catch (e) {
    console.error("vtunaija-cabletv-catalog: provider fetch failed:", e instanceof Error ? e.message : e);
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }
  if (!Array.isArray(payload?.cabletvplans)) {
    console.error("vtunaija-cabletv-catalog: unexpected response shape:", JSON.stringify(payload).slice(0, 500));
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }

  const rows: {
    id: string; provider: typeof PROVIDERS[number]; cabletv_plan_id: string;
    name: string; validity: string; reseller_kobo: number; available: boolean;
  }[] = [];
  let skipped = 0;

  // A single malformed plan must never abort the WHOLE sync (the exact bug
  // that froze vtunaija-data-catalog's sync silently forever, confirmed live
  // 2026-08-03) â€?skip just that one row and keep going.
  for (const raw of payload.cabletvplans as Record<string, unknown>[]) {
    const provider = PROVIDER_NAME_MAP[String(raw.the_cabletv_name).toUpperCase()];
    if (!provider) continue; // SHOWMAX or anything unsupported â€?not an error

    const planId = String(raw.cabletv_plan_id ?? "");
    const priceNaira = Number(raw.price_for_premiumuser);
    const size = String(raw.size ?? "").trim();
    const durationDays = String(raw.duration ?? "").trim();

    if (!/^\d+$/.test(planId) || !size || !Number.isFinite(priceNaira) || priceNaira <= 0) {
      skipped++;
      continue;
    }

    rows.push({
      id: `vtunaija-${provider}-${planId}`,
      provider,
      cabletv_plan_id: planId,
      name: size,
      validity: durationDays ? `${durationDays} Days` : "See provider",
      reseller_kobo: Math.round(priceNaira * 100),
      available: String(raw.status ?? "").toLowerCase() === "on",
    });
  }

  if (skipped > 0) console.warn(`vtunaija-cabletv-catalog: skipped ${skipped} malformed plan(s) this sync`);
  return rows;
}

async function refreshCatalog(supabase: ReturnType<typeof adminClient>) {
  const rows = await fetchCatalog(); // already logs + throws CatalogSyncError itself
  if (PROVIDERS.some((provider) => rows.filter((row) => row.provider === provider).length < 3) || rows.length < 10) {
    console.error(
      "vtunaija-cabletv-catalog: snapshot too small after filtering,",
      `total=${rows.length}`,
      PROVIDERS.map((p) => `${p}=${rows.filter((r) => r.provider === p).length}`).join(", "),
    );
    throw new CatalogSyncError("SNAPSHOT_INVALID");
  }
  const now = new Date().toISOString();
  const storedRows = rows.map((row) => ({ ...row, provider_seen_at: now, updated_at: now }));
  const { error } = await supabase
    .from("vtunaija_cabletv_catalog")
    .upsert(storedRows, { onConflict: "id" });
  if (error) {
    console.error("vtunaija-cabletv-catalog: database save failed:", error.message);
    throw new CatalogSyncError("DATABASE_SAVE_FAILED");
  }

  const incomingIds = new Set(rows.map((row) => row.id));
  const { data: existing } = await supabase.from("vtunaija_cabletv_catalog").select("id").eq("available", true);
  const disappeared = (existing ?? []).filter((row) => !incomingIds.has(row.id)).map((row) => row.id);
  if (disappeared.length > 0) {
    await supabase.from("vtunaija_cabletv_catalog").update({ available: false, updated_at: now }).in("id", disappeared);
  }

  return { stored: rows.length, available: rows.filter((row) => row.available).length };
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const supabase = adminClient();

  if (body.refresh === true) {
    if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
    try {
      const result = await withJobLock(supabase, "vtunaija-cabletv-catalog-sync", () => refreshCatalog(supabase));
      return json({ success: true, ...result });
    } catch (e) {
      console.error("vtunaija-cabletv-catalog: refresh failed:", e instanceof Error ? e.message : e);
      return json({ success: false, error: "Catalogue refresh failed; last valid prices retained." }, 502);
    }
  }

  if (body.health === true) {
    let bootstrapCode: string | null = null;
    let { data: rows, error } = await supabase
      .from("vtunaija_cabletv_catalog")
      .select("provider, provider_seen_at")
      .eq("available", true);
    if (error) return json({ healthy: false }, 503);
    if ((rows ?? []).length === 0) {
      try {
        await withJobLock(supabase, "vtunaija-cabletv-catalog-sync", () => refreshCatalog(supabase));
        const refreshed = await supabase
          .from("vtunaija_cabletv_catalog")
          .select("provider, provider_seen_at")
          .eq("available", true);
        rows = refreshed.data;
      } catch (error) {
        bootstrapCode = error instanceof CatalogSyncError ? error.safeCode : "SYNC_UNAVAILABLE";
      }
    }
    const counts = Object.fromEntries(PROVIDERS.map((item) => [item, 0])) as Record<string, number>;
    let freshest: string | null = null;
    for (const row of rows ?? []) {
      counts[row.provider] = (counts[row.provider] ?? 0) + 1;
      if (!freshest || row.provider_seen_at > freshest) freshest = row.provider_seen_at;
    }
    return json({ healthy: (rows ?? []).length > 0, counts, updated_at: freshest, bootstrap_code: bootstrapCode });
  }

  if (!(await getAuthUser(req))) return json({ error: "Unauthorized" }, 401);
  const provider = String(body.provider ?? "").toLowerCase();
  if (!PROVIDERS.includes(provider as typeof PROVIDERS[number])) return json({ error: "Invalid provider" }, 400);

  let { data, error } = await supabase
    .from("vtunaija_cabletv_catalog")
    .select("id, provider, cabletv_plan_id, name, validity, reseller_kobo, provider_seen_at")
    .eq("provider", provider)
    .eq("available", true)
    .order("reseller_kobo", { ascending: true });
  if (error) return json({ error: "Catalogue temporarily unavailable" }, 503);

  if ((data ?? []).length === 0) {
    try {
      await withJobLock(supabase, "vtunaija-cabletv-catalog-sync", () => refreshCatalog(supabase));
      const refreshed = await supabase
        .from("vtunaija_cabletv_catalog")
        .select("id, provider, cabletv_plan_id, name, validity, reseller_kobo, provider_seen_at")
        .eq("provider", provider)
        .eq("available", true)
        .order("reseller_kobo", { ascending: true });
      data = refreshed.data;
    } catch {
      // Fall through with an empty list; the scheduled sync will retry.
    }
  }

  // Admin-settable per-bouquet price (see migration 114) â€?same lookup
  // vtu-purchase uses at charge time, so the quote and the actual charge
  // always agree.
  const { data: overrides } = await supabase
    .from("vtu_cabletv_price_overrides")
    .select("plan_id, price_kobo")
    .eq("provider", provider);
  const priceByPlan = new Map((overrides ?? []).map((row) => [row.plan_id, Number(row.price_kobo)]));

  return json({
    success: true,
    bouquets: (data ?? []).map((row) => ({
      id: row.id,
      provider: row.provider,
      name: row.name,
      validity: row.validity,
      amount: (priceByPlan.get(row.cabletv_plan_id) ?? Number(row.reseller_kobo)) / 100,
    })),
    updated_at: data?.[0]?.provider_seen_at ?? null,
  });
});
