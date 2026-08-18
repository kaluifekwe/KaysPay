import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { getAllMarketTickers, isQuidaxConfigured } from "../_shared/quidax-client.ts";
import { SUPPORTED_SWAP_ASSETS } from "../_shared/crypto-assets.ts";

// Read-only live prices for the Buy coin picker — one call to Quidax's
// "list market tickers" endpoint covers every market, so this picks out the
// curated coin list's own <code>ngn pair instead of a per-coin round trip.
// Never used to charge anyone: crypto-buy re-derives its own price
// server-side against a fresh ticker/quote at purchase time.
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
    return json({ success: false, error: "Live prices aren't available right now." }, 503);
  }

  try {
    const tickers = await getAllMarketTickers();

    const usdtNgn = tickers["usdtngn"];
    const coins = [
      { code: "USDT", name: "Tether", stablecoin: true, quidaxCode: "usdt" },
      ...SUPPORTED_SWAP_ASSETS.map((a) => ({ code: a.code, name: a.name, stablecoin: false, quidaxCode: a.quidaxCode })),
    ].map((coin) => {
      // Prefer a direct <coin>ngn market where Quidax lists one (most
      // majors). Several coins here (confirmed against Quidax's own
      // "Supported cryptocurrencies" table) only quote against usdt, not
      // ngn — SOL, DOGE, ADA — so those fall back to a cross rate via the
      // live USDT/NGN price instead of being silently dropped.
      const direct = tickers[`${coin.quidaxCode}ngn`];
      if (direct) {
        const changePct = direct.open ? ((direct.last - direct.open) / direct.open) * 100 : null;
        return {
          code: coin.code,
          name: coin.name,
          stablecoin: coin.stablecoin,
          price_ngn: direct.last,
          change_24h_pct: changePct != null && Number.isFinite(changePct) ? Math.round(changePct * 100) / 100 : null,
        };
      }

      const viaUsdt = coin.quidaxCode === "usdt" ? usdtNgn : tickers[`${coin.quidaxCode}usdt`];
      if (!viaUsdt || !usdtNgn) return null;
      const priceNgn = coin.quidaxCode === "usdt" ? usdtNgn.last : viaUsdt.last * usdtNgn.last;
      // The coin's own USDT-quoted change% is a close enough proxy for its
      // NGN change — USDT/NGN itself moves far less over 24h than most
      // altcoins do — rather than fabricating a number with no real source.
      const changePct = viaUsdt.open ? ((viaUsdt.last - viaUsdt.open) / viaUsdt.open) * 100 : null;
      return {
        code: coin.code,
        name: coin.name,
        stablecoin: coin.stablecoin,
        price_ngn: priceNgn,
        change_24h_pct: changePct != null && Number.isFinite(changePct) ? Math.round(changePct * 100) / 100 : null,
      };
    }).filter((c): c is NonNullable<typeof c> => c !== null);

    return json({
      success: true,
      coins,
      // Kept separate — the Buy amount is entered in USDT, so the app needs
      // this to convert the customer's budget into Naira regardless of
      // which coin they picked.
      usdt_ngn_rate: usdtNgn?.last ?? null,
    });
  } catch (e) {
    console.error("crypto-markets: failed:", e instanceof Error ? e.message : e);
    return json({ success: false, error: "Could not load live prices. Please try again." }, 500);
  }
});
