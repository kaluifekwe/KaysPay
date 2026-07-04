import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";
import { getPrices, getNumber, isGrizzlySMSConfigured, GrizzlySMSError } from "../_shared/grizzlysms-client.ts";
import {
  isValidServiceCode,
  usdToNgnKobo,
  FOREIGN_NUMBER_SERVICES,
} from "../_shared/foreign-number-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newIdempotencyKey() {
  return `fnum_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

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
  const country = String(body?.country || "");

  if (!isValidServiceCode(service)) return json({ success: false, error: "Unknown service" }, 400);
  if (!/^\d+$/.test(country)) return json({ success: false, error: "Invalid country" }, 400);

  const supabase = adminClient();

  // Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) return json({ success: false, error: "Re-authorization required. Please try again." }, 401);

  // Re-fetch the live price ourselves — never trust a client-supplied price.
  let priceUSD: number;
  try {
    const prices = await getPrices(country);
    const entry = prices?.[service];
    if (!entry || !Number.isFinite(entry.cost) || entry.count <= 0) {
      return json({ success: false, error: "No numbers currently available for this combination" });
    }
    priceUSD = entry.cost;
  } catch {
    return json({ success: false, error: "Could not verify current price. Please try again." });
  }

  const amountKobo = usdToNgnKobo(priceUSD);
  const requestId = String(body.idempotency_key || newIdempotencyKey());
  const serviceName = FOREIGN_NUMBER_SERVICES.find((s) => s.id === service)?.name || service;

  const { data: txId, error: debitError } = await supabase.rpc("debit_for_service", {
    p_user_id: user.id,
    p_amount: amountKobo,
    p_type: "foreign_number",
    p_network: "N/A",
    p_recipient: `${serviceName} (${country})`,
    p_metadata: { service, service_name: serviceName, country, price_usd: priceUSD },
    p_idempotency_key: requestId,
  });

  if (debitError) {
    const msg = debitError.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) return json({ success: false, error: "Insufficient balance" });
    if (msg.includes("WALLET_NOT_FOUND")) return json({ success: false, error: "Wallet not found" });
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  // Rented number itself is the paid-for good — complete on successful
  // rental, independent of whether an SMS code ever arrives (that's a
  // separate, non-money-moving polling step the client does afterward).
  try {
    // maxPrice is a safety cap in the SAME currency as getPrices' "cost"
    // field (USD) — a small buffer above the price we just read, so a
    // price bump between our check and this call fails cleanly instead of
    // silently overcharging our own GrizzlySMS balance.
    const result = await getNumber(service, country, Math.round((priceUSD * 1.05 + Number.EPSILON) * 100) / 100);

    if ("error" in result) {
      await supabase.rpc("refund_service_transaction", { p_tx_id: txId, p_reason: result.error });
      return json({ success: false, error: humanizeGrizzlyError(result.error) });
    }

    await supabase.rpc("complete_service_transaction", { p_tx_id: txId, p_order_id: result.activationId });

    return json({
      success: true,
      transaction_id: txId,
      activation_id: result.activationId,
      phone_number: result.phoneNumber,
      service_name: serviceName,
      amount: amountKobo,
    });
  } catch (e) {
    const isAuthError = e instanceof GrizzlySMSError;
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: isAuthError ? `grizzlysms_config: ${e.message}` : "provider_unreachable",
    });
    return json({
      success: false,
      error: isAuthError ? "Provider not configured. Please try again later." : "Network error. Please try again. You were not charged.",
    });
  }
});

function humanizeGrizzlyError(code: string): string {
  if (code.includes("NO_NUMBERS")) return "No numbers currently available. Please try a different country.";
  if (code.includes("NO_BALANCE")) return "Service temporarily unavailable. Please try again later.";
  if (code.includes("BAD_KEY")) return "Provider configuration error. Please try again later.";
  return "Purchase failed. You were not charged.";
}
