import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { isQuidaxRampConfigured, listOffRampBanks } from "../_shared/quidax-ramp-client.ts";
import { withBankLogos } from "../_shared/bank-logos.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Bank list for the Sell (off-ramp) destination picker. Deliberately its
// own function rather than reusing crypto-banks: that one lists the
// Exchange API's banks, a different Quidax product with a possibly
// different code scheme — never confirmed they match, so kept separate to
// avoid a code from one resolving to the wrong bank on the other.
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

  try {
    const banks = await listOffRampBanks();
    const withLogos = await withBankLogos(banks.filter((b) => b.code && b.name));
    return json({
      success: true,
      banks: withLogos.sort((a, b) => a.name.localeCompare(b.name)),
    });
  } catch (e) {
    console.error("crypto-sell-banks failed:", redactSecrets(e));
    return json({ success: false, error: "Could not load the bank list. Please try again." }, 500);
  }
});
