import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser } from "../_shared/auth.ts";
import { isQuidaxConfigured, listBanks } from "../_shared/quidax-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Quidax's own NG bank list (exchange API) — used by the crypto Buy refund
// bank picker. Deliberately its own function rather than reusing
// transfer-banks: that one lists Flutterwave's banks, a different provider
// with a different code scheme, and a refund submitted with a mismatched
// code would resolve to the wrong bank entirely.
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

  if (!isQuidaxConfigured()) {
    return json({ success: false, error: "Not available yet." }, 503);
  }

  // Bank lists are cached client-side, so 20/min is generous for real use.
  const rate = await enforceRateLimit(adminClient(), "crypto_banks", user.id, 20, 60, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Please wait a moment and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  try {
    const banks = await listBanks();
    return json({
      success: true,
      banks: banks
        .map((b) => ({ code: b.code, name: b.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    console.error("crypto-banks failed:", redactSecrets(e));
    return json({ success: false, error: "Could not load the bank list. Please try again." }, 500);
  }
});
