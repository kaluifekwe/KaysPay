import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, enforceRateLimit } from "../_shared/auth.ts";
import { browseAiraloPackages, fetchAiraloCatalog, isAiraloConfigured } from "../_shared/airalo-client.ts";
import { usdToNgnKobo, getUsdNgnRate, NormalizedEsimPlan } from "../_shared/esim-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fromAiralo(raw: any, rate: number): NormalizedEsimPlan[] {
  const plans: NormalizedEsimPlan[] = [];
  for (const country of raw?.data || []) {
    for (const operator of country?.operators || []) {
      for (const pkg of operator?.packages || []) {
        const priceUSD = Number(pkg?.prices?.net_price?.USD ?? pkg?.net_price ?? pkg?.price);
        if (!Number.isFinite(priceUSD) || !pkg?.id) continue;
        plans.push({
          id: `airalo:${pkg.id}`,
          provider: "airalo",
          providerPackageId: pkg.id,
          name: pkg.title || pkg.data,
          dataMB: pkg.is_unlimited ? null : Number(pkg.amount) || null,
          days: Number(pkg.day) || 0,
          priceUSD,
          priceKobo: usdToNgnKobo(priceUSD, rate),
        });
      }
    }
  }
  return plans;
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const region = String(body?.region || "").trim();
  const country = String(body?.country || "").toUpperCase();
  if (!region && !/^[A-Z]{2}$/.test(country)) {
    return json({ success: false, error: "Invalid destination" }, 400);
  }

  if (!isAiraloConfigured()) return json({ success: false, error: "eSIM provider not configured" }, 500);

  const supabase = adminClient();

  // Named limitCheck, not `rate` — `rate` is already the FX rate below.
  const limitCheck = await enforceRateLimit(supabase, "esim_browse", user.id, 20, 60, user.id);
  if (!limitCheck.allowed) {
    return json({
      success: false,
      error: "Please wait a moment and try again.",
      retry_after_seconds: limitCheck.retryAfterSeconds,
    }, 429);
  }

  let plans: NormalizedEsimPlan[] = [];
  try {
    const rate = await getUsdNgnRate(supabase);
    if (region) {
      // Regional / worldwide plans live in the "global" catalogue; keep only
      // the entry whose slug matches the requested region.
      const raw = await fetchAiraloCatalog(supabase, "global");
      const entry = (raw?.data || []).find((c: any) => String(c?.slug || "") === region);
      plans = fromAiralo({ data: entry ? [entry] : [] }, rate);
    } else {
      plans = fromAiralo(await browseAiraloPackages(supabase, country), rate);
    }
  } catch {
    return json({ success: false, error: "Could not load eSIM plans. Please try again." });
  }

  plans.sort((a, b) => a.priceKobo - b.priceKobo);

  return json({ success: true, plans });
});
