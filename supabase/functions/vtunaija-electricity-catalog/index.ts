import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { callVTUNaija } from "../_shared/vtunaija-client.ts";

// Small server-internal lookup (VTUnaija's disco_name codes -> their own
// provider names) â€?never queried directly by the client. vtu-purchase joins
// against it via VTUNAIJA_ELECTRICITY_NAME_MAP (_shared/vtu-catalog.ts) to
// resolve the app's own DISCO id to VTUnaija's current numeric code. No
// pricing here: electricity amount is customer-entered, like airtime.

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
    payload = await callVTUNaija("/listelectricity/", {});
  } catch (e) {
    console.error("vtunaija-electricity-catalog: provider fetch failed:", e instanceof Error ? e.message : e);
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }
  if (!Array.isArray(payload?.electricityplanids)) {
    console.error("vtunaija-electricity-catalog: unexpected response shape:", JSON.stringify(payload).slice(0, 500));
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  }

  const rows: { disco_id: string; name: string; available: boolean }[] = [];
  let skipped = 0;

  // A single malformed row must never abort the whole sync â€?same lesson
  // learned live from vtunaija-data-catalog freezing silently forever.
  for (const raw of payload.electricityplanids as Record<string, unknown>[]) {
    const discoId = String(raw.electricity_plan_id ?? "");
    const name = String(raw.the_electricty_name ?? "").trim();
    if (!/^\d+$/.test(discoId) || !name) {
      skipped++;
      continue;
    }
    // No `status` field is documented on this endpoint's response â€?assume
    // available; the purchase path fails closed regardless (INVALID_PROVIDER)
    // if a stale/wrong code ever gets used.
    rows.push({ disco_id: discoId, name, available: true });
  }

  if (skipped > 0) console.warn(`vtunaija-electricity-catalog: skipped ${skipped} malformed row(s) this sync`);
  return rows;
}

async function refreshCatalog(supabase: ReturnType<typeof adminClient>) {
  const rows = await fetchCatalog(); // already logs + throws CatalogSyncError itself
  if (rows.length < 6) {
    console.error(`vtunaija-electricity-catalog: snapshot too small after filtering, total=${rows.length}`);
    throw new CatalogSyncError("SNAPSHOT_INVALID");
  }

  const now = new Date().toISOString();
  const storedRows = rows.map((row) => ({ ...row, provider_seen_at: now, updated_at: now }));
  const { error } = await supabase
    .from("vtunaija_electricity_catalog")
    .upsert(storedRows, { onConflict: "disco_id" });
  if (error) {
    console.error("vtunaija-electricity-catalog: database save failed:", error.message);
    throw new CatalogSyncError("DATABASE_SAVE_FAILED");
  }

  const incomingIds = new Set(rows.map((row) => row.disco_id));
  const { data: existing } = await supabase.from("vtunaija_electricity_catalog").select("disco_id").eq("available", true);
  const disappeared = (existing ?? []).filter((row) => !incomingIds.has(row.disco_id)).map((row) => row.disco_id);
  if (disappeared.length > 0) {
    await supabase.from("vtunaija_electricity_catalog").update({ available: false, updated_at: now }).in("disco_id", disappeared);
  }

  return { stored: rows.length };
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
      const result = await withJobLock(supabase, "vtunaija-electricity-catalog-sync", () => refreshCatalog(supabase));
      return json({ success: true, ...result });
    } catch (e) {
      console.error("vtunaija-electricity-catalog: refresh failed:", e instanceof Error ? e.message : e);
      return json({ success: false, error: "Catalogue refresh failed; last valid list retained." }, 502);
    }
  }

  if (body.health === true) {
    // Read-only, non-sensitive (DISCO ids/names only) â€?no cron-secret gate,
    // matching vtu-data-catalog/vtunaija-cabletv-catalog's health path. Also
    // bootstraps on an empty table, same as those.
    let bootstrapCode: string | null = null;
    let { data: rows, error } = await supabase
      .from("vtunaija_electricity_catalog")
      .select("disco_id, name, provider_seen_at")
      .eq("available", true)
      .order("disco_id", { ascending: true });
    if (error) return json({ healthy: false }, 503);
    if ((rows ?? []).length === 0) {
      try {
        await withJobLock(supabase, "vtunaija-electricity-catalog-sync", () => refreshCatalog(supabase));
        const refreshed = await supabase
          .from("vtunaija_electricity_catalog")
          .select("disco_id, name, provider_seen_at")
          .eq("available", true)
          .order("disco_id", { ascending: true });
        rows = refreshed.data;
      } catch (e) {
        bootstrapCode = e instanceof CatalogSyncError ? e.safeCode : "SYNC_UNAVAILABLE";
      }
    }
    return json({ healthy: (rows ?? []).length > 0, count: (rows ?? []).length, rows, bootstrap_code: bootstrapCode });
  }

  return json({ error: "This endpoint is cron/service-internal only" }, 403);
});
