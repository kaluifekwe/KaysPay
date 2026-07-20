import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";
import { VALID_BETTING_IDS } from "../_shared/vtu-catalog.ts";
import { Features, SERVICE_DISABLED_MESSAGE } from "../_shared/features.ts";
import { callVTUAfrica, isVtuAfricaConfigured, VTUAfricaError } from "../_shared/vtuafrica-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Resolves a betting account id to its registered name before funding it —
// same "show the name before you pay" pattern as the bank-withdrawal flow —
// so a mistyped account id gets caught before money leaves the wallet.
// Routed to VTUAfrica's `merchant-verify` endpoint (betting funding itself
// runs on VTUAfrica — VTU.ng never had a working betting integration).
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isVtuAfricaConfigured()) return json({ error: "Betting provider not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  // Betting switched off 2026-07-18 — this function only ever serves betting
  // name lookups. Flip Features.BETTING_ENABLED to restore.
  if (!Features.BETTING_ENABLED) {
    return json({ success: false, error: SERVICE_DISABLED_MESSAGE }, 503);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const providerId = String(body?.provider_id || "");
  const customerId = String(body?.customer_id || "").trim();

  if (!VALID_BETTING_IDS.includes(providerId)) return json({ success: false, error: "Unknown betting platform" }, 400);
  if (!customerId) return json({ success: false, error: "Enter your betting account ID" }, 400);

  // 1xbet's /merchant-verify rejects even confirmed-correct account ids —
  // confirmed live 2026-07-06 with the owner's own real 1xBet account
  // (id 1728785375, VTUAfrica returned "Verification Failed. Invalid
  // Userid"). This is the opposite failure mode from the stub platforms
  // below (a false rejection instead of a false "Completed"), but the fix is
  // the same: don't let a broken provider-side check hard-block funding a
  // real account. Skip the call entirely and let the user proceed with a
  // "double-check this ID" warning instead.
  if (providerId === "1xbet") {
    return json({ success: true, unverifiable: true });
  }

  try {
    const result = await callVTUAfrica("/merchant-verify", {
      serviceName: "Betting",
      service: providerId,
      userid: customerId,
    });

    if (result?.code !== 101 || result?.description?.Status !== "Completed" || !result?.description?.Customer) {
      return json({ success: false, error: result?.description?.message || "Could not verify this account" });
    }

    // Some platforms' verify integration on VTUAfrica's side is a stub: it
    // reports "Completed" for ANY account id (even an obviously fake one),
    // echoing the platform's own name back as "Customer" instead of a real
    // registered name. Detected live (2026-07-02) for BetKing, BetBiga,
    // SportyBet, MelBet, LiveScoreBet, CloudBet, and Paripesa. Surface this
    // honestly rather than showing a false "✓ verified — <real name>" —
    // the funding call itself may still work, we just can't pre-check it.
    const customerName = result.description.Customer;
    if (customerName.trim().toLowerCase() === providerId.toLowerCase()) {
      return json({ success: true, unverifiable: true });
    }

    return json({ success: true, customer_name: customerName });
  } catch (e) {
    const isAuthError = e instanceof VTUAfricaError;
    return json({
      success: false,
      error: isAuthError ? "Provider not configured. Please try again later." : "Network error. Please try again.",
    });
  }
});
