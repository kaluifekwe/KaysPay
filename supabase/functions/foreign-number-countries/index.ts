import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { getServiceCountries, isGrizzlySMSConfigured } from "../_shared/grizzlysms-client.ts";
import { FOREIGN_NUMBER_COUNTRIES, isPlausibleServiceCode, usdToNgnKobo } from "../_shared/foreign-number-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Returns only the countries that currently have the chosen service IN STOCK,
// each with its live price — so the user picks from a guaranteed-available
// list instead of guessing and hitting "no numbers". Read-only, no money.
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

  const service = String(body?.service || "");
  if (!isPlausibleServiceCode(service)) return json({ success: false, error: "Unknown service" }, 400);

  try {
    const stock = await getServiceCountries(service);

    // Only surface countries we have a friendly name for (our catalog), each
    // with its live price. Sorted by name for easy scanning.
    const countries = FOREIGN_NUMBER_COUNTRIES
      .filter((c) => stock[c.id])
      .map((c) => ({
        id: c.id,
        name: c.name,
        priceKobo: usdToNgnKobo(stock[c.id].cost),
        available: stock[c.id].count,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return json({ success: true, countries });
  } catch {
    return json({ success: false, error: "Could not load available countries. Please try again." });
  }
});
