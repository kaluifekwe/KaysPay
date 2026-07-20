import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { getPrices, isGrizzlySMSConfigured } from "../_shared/grizzlysms-client.ts";
import { FOREIGN_NUMBER_SERVICES, isPlausibleServiceCode, usdToNgnKobo } from "../_shared/foreign-number-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Read-only: fetches the CURRENT live price for a service+country pair, no
// money moved. Same "never hardcode a price we can't guarantee" reasoning
// as eSIM — GrizzlySMS's own balance gets charged whatever the live rate
// is, so the customer needs to see that same live rate before paying.
//
// Service is optional: GrizzlySMS's getPrices(country) returns pricing for
// every service in one call, so when no service is given we scan our own
// catalog for the cheapest in-stock option and return which one we picked.
// There's no "any app" number at the provider level — a service code is
// still required to actually rent one — this just chooses it for the user.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isGrizzlySMSConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const service = body?.service ? String(body.service) : "";
  const country = String(body?.country || "");

  if (service && !isPlausibleServiceCode(service)) return json({ success: false, error: "Unknown service" }, 400);
  if (!/^\d+$/.test(country)) return json({ success: false, error: "Invalid country" }, 400);

  try {
    const prices = await getPrices(country);

    if (service) {
      const entry = prices?.[service];
      if (!entry || !Number.isFinite(entry.cost) || entry.count <= 0) {
        return json({ success: false, error: "No numbers currently available for this combination" });
      }
      const name = FOREIGN_NUMBER_SERVICES.find((s) => s.id === service)?.name || service;
      return json({
        success: true,
        priceUSD: entry.cost,
        priceKobo: usdToNgnKobo(entry.cost),
        available: entry.count,
        service,
        serviceName: name,
      });
    }

    let best: { code: string; name: string; cost: number; count: number } | null = null;
    for (const s of FOREIGN_NUMBER_SERVICES) {
      const entry = prices?.[s.id];
      if (!entry || !Number.isFinite(entry.cost) || entry.count <= 0) continue;
      if (!best || entry.cost < best.cost) best = { code: s.id, name: s.name, cost: entry.cost, count: entry.count };
    }
    if (!best) return json({ success: false, error: "No numbers currently available for this country" });
    return json({
      success: true,
      priceUSD: best.cost,
      priceKobo: usdToNgnKobo(best.cost),
      available: best.count,
      service: best.code,
      serviceName: best.name,
    });
  } catch {
    return json({ success: false, error: "Could not fetch live price. Please try again." });
  }
});
