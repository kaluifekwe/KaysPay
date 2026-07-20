import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { browseAiraloPackages, isAiraloConfigured } from "../_shared/airalo-client.ts";
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

  if (!isAiraloConfigured()) return json({ success: false, error: "eSIM provider not configured" }, 500);

  const supabase = adminClient();
  let plans: NormalizedEsimPlan[] = [];
  try {
    plans = fromAiralo(await browseAiraloPackages(supabase, country));
  } catch {
    return json({ success: false, error: "Could not load eSIM plans. Please try again." });
  }

  plans.sort((a, b) => a.priceKobo - b.priceKobo);

  return json({ success: true, plans });
});
