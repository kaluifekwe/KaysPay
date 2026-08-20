import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { isQuidaxRampConfigured } from "../_shared/quidax-ramp-client.ts";
import { resolveBuyLimits } from "../_shared/crypto-buy-limits.ts";

// Lets the Buy amount screen show the real min/max BEFORE the customer
// commits — same resolveBuyLimits() crypto-buy itself enforces, so what's
// displayed can never say something different from what actually gets
// accepted. Built after a real purchase (₦2,790) got silently accepted,
// took a real deposit, and then hung forever because it was below a
// minimum nothing in the UI had told the customer about.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isQuidaxRampConfigured()) {
    return json({ success: false, error: "Not available yet." }, 503);
  }

  const { minNgn, maxNgn } = await resolveBuyLimits();
  return json({ success: true, min_ngn: minNgn, max_ngn: maxNgn });
});
