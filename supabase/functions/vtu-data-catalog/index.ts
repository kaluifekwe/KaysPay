import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { fetchWithTimeout } from "../_shared/provider-fetch.ts";

const NETWORKS = ["mtn", "airtel", "glo"] as const;
const CATALOG_URL = "https://vtu.ng/wp-json/api/v2/variations/data";

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

function splitPlanLabel(label: string): { name: string; validity: string } {
  const parts = label.split(" - ").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return { name: label.trim(), validity: "See provider" };
  return { name: parts.slice(0, -1).join(" - "), validity: parts.at(-1) ?? "See provider" };
}

async function fetchCatalog() {
  const response = await fetchWithTimeout(CATALOG_URL, {
    method: "GET",
    headers: { Accept: "application/json" },
  }, 15_000);
  if (!response.ok) throw new Error(`catalog HTTP ${response.status}`);
  const payload = await response.json();
  if (!Array.isArray(payload?.data)) throw new Error("invalid catalog response");

  return payload.data.filter((raw: Record<string, unknown>) =>
    NETWORKS.includes(String(raw.service_id).toLowerCase() as typeof NETWORKS[number])
  ).map((raw: Record<string, unknown>) => {
    const network = String(raw.service_id).toLowerCase() as typeof NETWORKS[number];
    const variationId = String(raw.variation_id ?? "");
    const resellerNaira = Number(raw.reseller_price);
    const label = String(raw.data_plan ?? "").trim();
    const parsed = splitPlanLabel(label);
    if (!/^\d+$/.test(variationId) || !label || !Number.isFinite(resellerNaira) || resellerNaira <= 0) {
      throw new Error("invalid catalog plan");
    }
    return {
      id: `vtung-${network}-${variationId}`,
      network,
      variation_id: variationId,
      name: parsed.name,
      validity: parsed.validity,
      reseller_kobo: Math.round(resellerNaira * 100),
      available: String(raw.availability).toLowerCase() === "available",
    };
  });
}

async function refreshCatalog(supabase: ReturnType<typeof adminClient>) {
  let rows;
  try {
    rows = await fetchCatalog();
  } catch {
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }
  if (NETWORKS.some((network) => rows.filter((row) => row.network === network).length < 3) || rows.length < 10) {
    throw new CatalogSyncError("SNAPSHOT_INVALID");
  }
  const now = new Date().toISOString();
  const storedRows = rows.map((row) => ({ ...row, provider_seen_at: now, updated_at: now }));
  const { error } = await supabase
    .from("vtung_data_catalog")
    .upsert(storedRows, { onConflict: "id" });
  if (error) throw new CatalogSyncError("DATABASE_SAVE_FAILED");

  // A plan removed entirely from the provider response cannot stay sellable.
  // This runs only after the new valid snapshot is safely stored.
  const incomingIds = new Set(rows.map((row) => row.id));
  const { data: existing } = await supabase.from("vtung_data_catalog").select("id").eq("available", true);
  const disappeared = (existing ?? []).filter((row) => !incomingIds.has(row.id)).map((row) => row.id);
  if (disappeared.length > 0) {
    await supabase.from("vtung_data_catalog").update({ available: false, updated_at: now }).in("id", disappeared);
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
      const result = await withJobLock(supabase, "vtung-data-catalog-sync", () => refreshCatalog(supabase));
      return json({ success: true, ...result });
    } catch {
      return json({ success: false, error: "Catalogue refresh failed; last valid prices retained." }, 502);
    }
  }

  // Non-sensitive deployment health check. It exposes counts and freshness,
  // never plan prices or provider credentials, and still sits behind the
  // gateway's required JWT (the public app anon JWT is sufficient).
  if (body.health === true) {
    let bootstrapCode: string | null = null;
    let { data: rows, error } = await supabase
      .from("vtung_data_catalog")
      .select("network, provider_seen_at")
      .eq("available", true);
    if (error) return json({ healthy: false }, 503);
    if ((rows ?? []).length === 0) {
      try {
        await withJobLock(supabase, "vtung-data-catalog-sync", () => refreshCatalog(supabase));
        const refreshed = await supabase
          .from("vtung_data_catalog")
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
    .from("vtung_data_catalog")
    .select("id, network, name, validity, reseller_kobo, provider_seen_at")
    .eq("network", network)
    .eq("available", true)
    .order("reseller_kobo", { ascending: true });
  if (error) return json({ error: "Catalogue temporarily unavailable" }, 503);

  // One-time bootstrap for a fresh deployment. The lock ensures a burst of
  // app opens cannot fan out into repeated provider catalogue requests.
  if ((data ?? []).length === 0) {
    try {
      await withJobLock(supabase, "vtung-data-catalog-sync", () => refreshCatalog(supabase));
      const refreshed = await supabase
        .from("vtung_data_catalog")
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
