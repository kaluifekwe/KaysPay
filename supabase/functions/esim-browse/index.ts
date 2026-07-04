import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { browseAiraloPackages, isAiraloConfigured } from "../_shared/airalo-client.ts";
import { listESIMAccessPackages, isESIMAccessConfigured } from "../_shared/esimaccess-client.ts";
import { usdToNgnKobo, NormalizedEsimPlan } from "../_shared/esim-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function fromAiralo(raw: any): NormalizedEsimPlan[] {
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
          priceKobo: usdToNgnKobo(priceUSD),
        });
      }
    }
  }
  return plans;
}

function fromESIMAccess(raw: any): NormalizedEsimPlan[] {
  const plans: NormalizedEsimPlan[] = [];
  for (const pkg of raw?.obj?.packageList || []) {
    const priceUSD = Number(pkg?.price) / 10000;
    if (!Number.isFinite(priceUSD) || !pkg?.packageCode) continue;
    const isDay = pkg?.durationUnit === "DAY";
    plans.push({
      id: `esimaccess:${pkg.packageCode}`,
      provider: "esimaccess",
      providerPackageId: pkg.packageCode,
      name: pkg.name || pkg.description,
      dataMB: Number(pkg.volume) / (1024 * 1024) || null,
      days: isDay ? Number(pkg.duration) || 0 : 0,
      priceUSD,
      priceKobo: usdToNgnKobo(priceUSD),
    });
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

  const country = String(body?.country || "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return json({ success: false, error: "Invalid country code" }, 400);

  const supabase = adminClient();
  const results = await Promise.allSettled([
    isAiraloConfigured() ? browseAiraloPackages(supabase, country) : Promise.resolve(null),
    isESIMAccessConfigured() ? listESIMAccessPackages(country) : Promise.resolve(null),
  ]);

  let plans: NormalizedEsimPlan[] = [];

  if (results[0].status === "fulfilled" && results[0].value) {
    try {
      plans = plans.concat(fromAiralo(results[0].value));
    } catch {
      // Malformed response from Airalo — skip their plans this round rather
      // than fail the whole browse request; eSIM Access may still have results.
    }
  }
  if (results[1].status === "fulfilled" && results[1].value) {
    try {
      plans = plans.concat(fromESIMAccess(results[1].value));
    } catch {
      // Same reasoning as above, for eSIM Access.
    }
  }

  plans.sort((a, b) => a.priceKobo - b.priceKobo);

  return json({ success: true, plans });
});
