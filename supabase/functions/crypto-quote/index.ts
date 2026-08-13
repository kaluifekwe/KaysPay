import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser } from "../_shared/auth.ts";
import { getUsdNgnRate } from "../_shared/esim-catalog.ts";
import { getMarketTicker, isQuidaxConfigured } from "../_shared/quidax-client.ts";

// Read-only live USDT/NGN price for the Crypto screen, sourced from Quidax's
// own order book — the market users actually trade against. It previously
// reused the interbank USD/NGN feed built for eSIM pricing, which is a
// once-daily bank rate sitting well below the real USDT market rate in
// Nigeria, so the screen understated what a sale was worth and crypto-buy
// systematically sold USDT below market.
//
// Never used to charge anyone: crypto-buy re-derives its own price
// server-side, and crypto-sell executes against a fresh Quidax swap
// quotation, so what's shown here is only ever an estimate.
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

  if (isQuidaxConfigured()) {
    try {
      const ticker = await getMarketTicker("usdtngn");
      return json({
        success: true,
        rate: ticker.last,
        // Buying costs the ask, selling earns the bid — exposed separately
        // so each side of the screen can show the price it would really get
        // rather than a single mid-market number that flatters both.
        buy_rate: ticker.ask,
        sell_rate: ticker.bid,
        source: "quidax",
      });
    } catch (e) {
      // Falls through to the FX feed below — a price hiccup must never
      // leave the screen with no rate at all.
      console.error("crypto-quote: Quidax ticker failed:", e instanceof Error ? e.message : e);
    }
  }

  const rate = await getUsdNgnRate(adminClient());
  return json({ success: true, rate, buy_rate: rate, sell_rate: rate, source: "fx_fallback" });
});
