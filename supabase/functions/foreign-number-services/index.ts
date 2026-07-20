import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { getServicesList, isGrizzlySMSConfigured } from "../_shared/grizzlysms-client.ts";
import { FOREIGN_NUMBER_SERVICES } from "../_shared/foreign-number-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Codes deliberately kept out of the "Other" browse list (e.g. removed for
// fraud-association reasons, same as the curated list). "mb" = Yahoo.
const EXCLUDED_CODES = new Set(["mb"]);

// Returns GrizzlySMS's full service catalog for the "Other / Browse all"
// picker — everything NOT already in our curated popular list (those are
// shown first) and not explicitly excluded. Read-only, no money moved.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isGrizzlySMSConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  try {
    const all = await getServicesList();
    const curated = new Set(FOREIGN_NUMBER_SERVICES.map((s) => s.id));

    const services = all
      .filter((s) => s?.code && s?.name && !curated.has(s.code) && !EXCLUDED_CODES.has(s.code))
      .map((s) => ({ id: s.code, name: s.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Pin the catch-all at the very top with a clean name (GrizzlySMS's own
    // label for "ot" is "AnyOther/Другой"). It's in the curated list too, so
    // it was filtered out of `services` above — re-add it here, cleanly.
    const withCatchAll = [{ id: "ot", name: "Any other service" }, ...services];

    return json({ success: true, services: withCatchAll });
  } catch {
    return json({ success: false, error: "Could not load the full service list. Please try again." });
  }
});
