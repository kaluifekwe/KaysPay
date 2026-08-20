import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, enforceRateLimit, adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { getPurchaseQuote, isQuidaxRampConfigured, QuidaxRampError } from "../_shared/quidax-ramp-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Live Buy-amount-screen estimate, sourced from Ramp's own quote endpoint
// instead of the exchange's usdtngn ticker — see getPurchaseQuote's doc
// comment for why: the ticker was showing customers close to double what
// they'd actually receive. USDT only; crypto-buy itself still re-derives
// the real price at purchase time regardless of what this shows.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const DELIVERY_NETWORK = "trc20";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isQuidaxRampConfigured()) {
    return json({ success: false, error: "Not available yet." }, 503);
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const ngnAmount = Number(body.ngn_amount);
  if (!Number.isFinite(ngnAmount) || ngnAmount <= 0) {
    return json({ success: false, error: "Invalid amount." }, 400);
  }

  const supabase = adminClient();
  const rate = await enforceRateLimit(supabase, "crypto_buy_quote", user.id, 30, 60, user.id);
  if (!rate.allowed) {
    return json({ success: false, error: "Too many attempts. Please wait a moment." }, 429);
  }

  try {
    const quote = await getPurchaseQuote({ fiatAmountNgn: ngnAmount, network: DELIVERY_NETWORK });
    return json({ success: true, usdt_amount: quote.toAmount });
  } catch (e) {
    console.error("crypto-buy-quote failed:", redactSecrets(e));
    const message = e instanceof QuidaxRampError ? redactSecrets(e.message) : null;
    return json({ success: false, error: message || "Could not get a live quote." }, 502);
  }
});
