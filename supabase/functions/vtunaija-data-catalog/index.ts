import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { callVTUNaija } from "../_shared/vtunaija-client.ts";

const NETWORKS = ["mtn", "glo", "9mobile", "airtel"] as const;

// VTUnaija's own catalog listing uses string network names; normalize to the
// lowercase keys used everywhere else (VTUNAIJA_NETWORK_IDS, this table).
const NETWORK_NAME_MAP: Record<string, typeof NETWORKS[number]> = {
  MTN: "mtn",
  GLO: "glo",
  "9MOBILE": "9mobile",
  AIRTEL: "airtel",
};

class CatalogSyncError extends Error {
  constructor(public readonly safeCode: "PROVIDER_FETCH_FAILED" | "SNAPSHOT_INVALID" | "DATABASE_SAVE_FAILED") {
    super(safeCode);
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, max-age=60" },
  });
}

async function fetchCatalog() {
  let payload: any;
  try {
    payload = await callVTUNaija("/listdataplans/", {});
  } catch (e) {
    console.error("vtunaija-data-catalog: provider fetch failed:", e instanceof Error ? e.message : e);
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }
  if (!Array.isArray(payload?.dataplans)) {
    console.error("vtunaija-data-catalog: unexpected response shape:", JSON.stringify(payload).slice(0, 500));
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }

  const rows: {
    id: string; network: typeof NETWORKS[number]; data_plan_id: string;
    name: string; validity: string; reseller_kobo: number; available: boolean;
  }[] = [];
  let skipped = 0;

  for (const raw of payload.dataplans as Record<string, unknown>[]) {
    const network = NETWORK_NAME_MAP[String(raw.the_network_name).toUpperCase()];
    if (!network) continue; // an unrelated/unsupported network name — not an error

    const dataPlanId = String(raw.data_plan_id ?? "");
    // Owner-confirmed tier: price_for_premiumuser is what this account is
    // actually billed, so that's the price passed on to customers.
    const priceNaira = Number(raw.price_for_premiumuser);
    const size = String(raw.size ?? "").trim();
    const datatype = String(raw.the_datatype_name ?? "").trim();
    const name = datatype ? `${size} (${datatype})` : size;
    const durationDays = String(raw.duration ?? "").trim();

    // A single malformed plan (odd price, blank name, paused entry) must
    // never abort the WHOLE sync — skip just that one row and keep going.
    // Confirmed live 2026-08-03: this used to throw on the first bad row,
    // silently freezing the entire catalog at its last-good snapshot forever
    // (the cron kept "running" every 5 min but every attempt failed here).
    if (!/^\d+$/.test(dataPlanId) || !size || !Number.isFinite(priceNaira) || priceNaira <= 0) {
      skipped++;
      continue;
    }

    rows.push({
      id: `vtunaija-${network}-${dataPlanId}`,
      network,
      data_plan_id: dataPlanId,
      name,
      validity: durationDays ? `${durationDays} Days` : "See provider",
      reseller_kobo: Math.round(priceNaira * 100),
      available: String(raw.status ?? "").toLowerCase() === "on",
    });
  }

  if (skipped > 0) console.warn(`vtunaija-data-catalog: skipped ${skipped} malformed plan(s) this sync`);
  return rows;
}

async function refreshCatalog(supabase: ReturnType<typeof adminClient>) {
  const rows = await fetchCatalog(); // already logs + throws CatalogSyncError itself
  if (NETWORKS.some((network) => rows.filter((row) => row.network === network).length < 3) || rows.length < 10) {
    console.error(
      "vtunaija-data-catalog: snapshot too small after filtering,",
      `total=${rows.length}`,
      NETWORKS.map((n) => `${n}=${rows.filter((r) => r.network === n).length}`).join(", "),
    );
    throw new CatalogSyncError("SNAPSHOT_INVALID");
  }
  const now = new Date().toISOString();
  const storedRows = rows.map((row) => ({ ...row, provider_seen_at: now, updated_at: now }));
  const { error } = await supabase
    .from("vtunaija_data_catalog")
    .upsert(storedRows, { onConflict: "id" });
  if (error) {
    console.error("vtunaija-data-catalog: database save failed:", error.message);
    throw new CatalogSyncError("DATABASE_SAVE_FAILED");
  }

  // A plan removed entirely from the provider response cannot stay sellable.
  const incomingIds = new Set(rows.map((row) => row.id));
  const { data: existing } = await supabase.from("vtunaija_data_catalog").select("id").eq("available", true);
  const disappeared = (existing ?? []).filter((row) => !incomingIds.has(row.id)).map((row) => row.id);
  if (disappeared.length > 0) {
    await supabase.from("vtunaija_data_catalog").update({ available: false, updated_at: now }).in("id", disappeared);
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
      const result = await withJobLock(supabase, "vtunaija-data-catalog-sync", () => refreshCatalog(supabase));
      if ("skipped" in result) console.warn("vtunaija-data-catalog: sync skipped, another run already holds the lock");
      return json({ success: true, ...result });
    } catch (e) {
      // The specific failure is already logged inside fetchCatalog/refreshCatalog
      // (safe codes only, no secrets) — this just confirms the sync as a whole
      // failed this round, so it's visible even without cross-referencing.
      console.error("vtunaija-data-catalog: refresh failed:", e instanceof Error ? e.message : e);
      return json({ success: false, error: "Catalogue refresh failed; last valid prices retained." }, 502);
    }
  }

  if (body.health === true) {
    let bootstrapCode: string | null = null;
    let { data: rows, error } = await supabase
      .from("vtunaija_data_catalog")
      .select("network, provider_seen_at")
      .eq("available", true);
    if (error) return json({ healthy: false }, 503);
    if ((rows ?? []).length === 0) {
      try {
        await withJobLock(supabase, "vtunaija-data-catalog-sync", () => refreshCatalog(supabase));
        const refreshed = await supabase
          .from("vtunaija_data_catalog")
          .select("network, provider_seen_at")
          .eq("available", true);
        rows = refreshed.data;
      } catch (error) {
        bootstrapCode = error instanceof CatalogSyncError ? error.safeCode : "SYNC_UNAVAILABLE";
      }
    }
    const counts = Object.fromEntries(NETWORKS.map((item) => [item, 0])) as Record<string, number>;
    let freshest: string | null = null;
    for (const row of rows ?? []) {
      counts[row.network] = (counts[row.network] ?? 0) + 1;
      if (!freshest || row.provider_seen_at > freshest) freshest = row.provider_seen_at;
    }
    return json({ healthy: (rows ?? []).length > 0, counts, updated_at: freshest, bootstrap_code: bootstrapCode });
  }

  if (!(await getAuthUser(req))) return json({ error: "Unauthorized" }, 401);
  const network = String(body.network ?? "").toLowerCase();
  if (!NETWORKS.includes(network as typeof NETWORKS[number])) return json({ error: "Invalid network" }, 400);

  let { data, error } = await supabase
    .from("vtunaija_data_catalog")
    .select("id, network, name, validity, reseller_kobo, provider_seen_at")
    .eq("network", network)
    .eq("available", true)
    .order("reseller_kobo", { ascending: true });
  if (error) return json({ error: "Catalogue temporarily unavailable" }, 503);

  // One-time bootstrap for a fresh deployment.
  if ((data ?? []).length === 0) {
    try {
      await withJobLock(supabase, "vtunaija-data-catalog-sync", () => refreshCatalog(supabase));
      const refreshed = await supabase
        .from("vtunaija_data_catalog")
        .select("id, network, name, validity, reseller_kobo, provider_seen_at")
        .eq("network", network)
        .eq("available", true)
        .order("reseller_kobo", { ascending: true });
      data = refreshed.data;
    } catch {
      // Fall through with an empty list; the scheduled sync will retry.
    }
  }

  return json({
    success: true,
    plans: (data ?? []).map((row) => ({
      id: row.id,
      network: row.network,
      name: row.name,
      validity: row.validity,
      amount: Number(row.reseller_kobo) / 100,
    })),
    updated_at: data?.[0]?.provider_seen_at ?? null,
  });
});
