import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { getServicePriceUSD, getAvailability, isSmspvaConfigured } from "../_shared/smspva-client.ts";
import {
  FOREIGN_NUMBER_SERVICES,
  isPlausibleServiceCode,
  isPlausibleCountryCode,
  usdToNgnKobo,
  isWithinPriceCap,
} from "../_shared/smspva-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Read-only: fetches the CURRENT live price for a service+country pair, no
// money moved. Never hardcodes a price — SMSPVA charges its live rate, so the
// customer sees that same live rate (× FX × margin) before paying.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isSmspvaConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

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

  if (!service || !isPlausibleServiceCode(service)) return json({ success: false, error: "Unknown service" }, 400);
  if (!isPlausibleCountryCode(country)) return json({ success: false, error: "Invalid country" }, 400);

  try {
    const [priceUSD, available] = await Promise.all([
      getServicePriceUSD(service, country),
      getAvailability(service, country),
    ]);
    if (priceUSD === null || available <= 0 || !isWithinPriceCap(priceUSD)) {
      return json({ success: false, error: "No numbers currently available for this combination" });
    }
    const name = FOREIGN_NUMBER_SERVICES.find((s) => s.id === service)?.name || service;
    return json({
      success: true,
      priceUSD,
      priceKobo: usdToNgnKobo(priceUSD),
      available,
      service,
      serviceName: name,
    });
  } catch {
    return json({ success: false, error: "Could not fetch live price. Please try again." });
  }
});
