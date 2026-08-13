import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, verifyCronSecret, withJobLock } from "../_shared/auth.ts";

const PRICING_URL = "https://vtunaija.com.ng/pricing/ourPricing.php";
const MAX_AUTOMATIC_CHANGE_RATIO = 0.20;

const PRODUCTS: Record<string, { id: string; code: number; name: string }> = {
  WAEC: { id: "waec", code: 1, name: "WAEC Exam PIN" },
  NECO: { id: "neco", code: 2, name: "NECO Exam PIN" },
  NABTEB: { id: "nabteb", code: 3, name: "NABTEB Exam PIN" },
  JAMB: { id: "jamb", code: 4, name: "JAMB Exam PIN" },
  WAECREGISTRATION: { id: "waec-registration", code: 5, name: "WAEC Registration PIN" },
  NBAIS: { id: "nbais", code: 6, name: "NBAIS Exam PIN" },
};

type CatalogRow = {
  id: string;
  exam_code: number;
  name: string;
  basic_kobo: number;
  premium_kobo: number;
};

class CatalogSyncError extends Error {}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "private, max-age=60" },
  });
}

function cleanCell(value: string): string {
  return value.replace(/<[^>]*>/g, "").replace(/&nbsp;/gi, " ").replace(/&#8358;|&amp;#8358;/gi, "₦").trim();
}

function parseNaira(value: string): number | null {
  const parsed = Number(cleanCell(value).replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed >= 100 && parsed <= 100000 ? Math.round(parsed * 100) : null;
}

export function parseExamPricingPage(html: string): CatalogRow[] {
  const section = html.match(/<h2>\s*EXAM PIN Pricing\s*<\/h2>[\s\S]*?<table[^>]*>([\s\S]*?)<\/table>/i)?.[1];
  if (!section) throw new CatalogSyncError("EXAM_TABLE_MISSING");

  const rows: CatalogRow[] = [];
  for (const rowMatch of section.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...rowMatch[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((match) => cleanCell(match[1]));
    if (cells.length < 5) continue;
    const product = PRODUCTS[cells[0].replace(/\s+/g, "").toUpperCase()];
    if (!product) continue;
    const basicKobo = parseNaira(cells[1]);
    const premiumKobo = parseNaira(cells[3]);
    if (!basicKobo || !premiumKobo) throw new CatalogSyncError(`INVALID_PRICE_${product.id}`);
    rows.push({ id: product.id, exam_code: product.code, name: product.name, basic_kobo: basicKobo, premium_kobo: premiumKobo });
  }

  if (rows.length !== 6 || new Set(rows.map((row) => row.id)).size !== 6) {
    throw new CatalogSyncError("INCOMPLETE_EXAM_SNAPSHOT");
  }
  return rows;
}

async function fetchProviderRows(): Promise<CatalogRow[]> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(PRICING_URL, { signal: controller.signal, headers: { Accept: "text/html" } });
    if (!response.ok) throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
    return parseExamPricingPage(await response.text());
  } catch (error) {
    if (error instanceof CatalogSyncError) throw error;
    throw new CatalogSyncError("PROVIDER_FETCH_FAILED");
  } finally {
    clearTimeout(timeout);
  }
}

async function pricingTier(db: ReturnType<typeof adminClient>): Promise<"premium" | "basic"> {
  const { data } = await db.from("vtu_pricing_config").select("tier").eq("product", "exam_pin").maybeSingle();
  return data?.tier === "basic" ? "basic" : "premium";
}

async function refreshCatalog(db: ReturnType<typeof adminClient>) {
  const [incoming, tier] = await Promise.all([fetchProviderRows(), pricingTier(db)]);
  const { data: existing, error: readError } = await db.from("vtunaija_exam_catalog").select("*");
  if (readError) throw new CatalogSyncError("DATABASE_READ_FAILED");
  const existingById = new Map((existing ?? []).map((row) => [row.id, row]));
  const now = new Date().toISOString();
  let updated = 0;
  let reviewRequired = 0;

  for (const row of incoming) {
    const previous = existingById.get(row.id);
    const nextCustomer = tier === "basic" ? row.basic_kobo : row.premium_kobo;
    const oldCustomer = Number(previous?.customer_kobo || nextCustomer);
    const significant = !!previous && Math.abs(nextCustomer - oldCustomer) / oldCustomer > MAX_AUTOMATIC_CHANGE_RATIO;
    const requiresReview = previous?.requires_review === true || significant;
    const available = requiresReview ? false : true;
    const customerKobo = requiresReview ? oldCustomer : nextCustomer;

    const { error } = await db.from("vtunaija_exam_catalog").upsert({
      ...row,
      customer_kobo: customerKobo,
      previous_customer_kobo: nextCustomer !== oldCustomer ? oldCustomer : previous?.previous_customer_kobo ?? null,
      available: available,
      requires_review: requiresReview,
      provider_seen_at: now,
      updated_at: now,
    }, { onConflict: "id" });
    if (error) throw new CatalogSyncError("DATABASE_SAVE_FAILED");

    if (significant) {
      reviewRequired++;
      await db.rpc("record_monitoring_alert", {
        p_fingerprint: `vtunaija_exam_price_${row.id}`,
        p_type: "vtu_exam_price_review_required",
        p_severity: "warning",
        p_details: { exam_id: row.id, old_kobo: oldCustomer, provider_kobo: nextCustomer, tier },
      });
    } else if (nextCustomer !== oldCustomer) {
      updated++;
    }
  }
  return { stored: incoming.length, updated, review_required: reviewRequired, tier };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { body = {}; }
  const db = adminClient();

  if (body.refresh === true) {
    if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
    try {
      const result = await withJobLock(db, "vtunaija-exam-catalog-sync", () => refreshCatalog(db));
      return json({ success: true, ...result });
    } catch (error) {
      console.error("vtunaija-exam-catalog sync failed:", error instanceof Error ? error.message : "unknown");
      return json({ success: false, error: "Exam catalogue refresh failed; last valid prices retained." }, 502);
    }
  }

  if (!(await getAuthUser(req))) return json({ error: "Unauthorized" }, 401);
  let { data, error } = await db
    .from("vtunaija_exam_catalog")
    .select("id, exam_code, name, customer_kobo, provider_seen_at")
    .eq("available", true)
    .eq("requires_review", false)
    .order("exam_code");
  if (error) return json({ error: "Exam catalogue temporarily unavailable" }, 503);

  if ((data ?? []).length === 0) {
    try {
      await withJobLock(db, "vtunaija-exam-catalog-sync", () => refreshCatalog(db));
      const refreshed = await db.from("vtunaija_exam_catalog")
        .select("id, exam_code, name, customer_kobo, provider_seen_at")
        .eq("available", true).eq("requires_review", false).order("exam_code");
      data = refreshed.data;
    } catch { /* retain empty safe response */ }
  }

  // Admin-settable markup (see migration 115) — same lookup vtu-purchase
  // uses at charge time, so the quote and the actual charge always agree.
  const { data: overrides } = await db.from("vtu_exam_price_overrides").select("exam_id, price_kobo");
  const priceByExam = new Map((overrides ?? []).map((row) => [row.exam_id, Number(row.price_kobo)]));

  return json({
    success: true,
    exams: (data ?? []).map((row) => ({
      id: row.id,
      name: row.name,
      amount: (priceByExam.get(row.id) ?? Number(row.customer_kobo)) / 100,
      quantity_options: [1],
    })),
    updated_at: data?.[0]?.provider_seen_at ?? null,
  });
});
