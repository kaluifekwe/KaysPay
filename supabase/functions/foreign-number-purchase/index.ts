import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import {
  getNumber,
  getServicePriceUSD,
  isSmspvaConfigured,
  SmspvaError,
} from "../_shared/smspva-client.ts";
import {
  FOREIGN_NUMBER_SERVICES,
  isPlausibleCountryCode,
  isPlausibleServiceCode,
  isWithinPriceCap,
  usdToNgnKobo,
} from "../_shared/smspva-catalog.ts";

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

  if (!isSmspvaConfigured()) {
    return json({ error: "Foreign Number provider not configured" }, 500);
  }

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const service = String(body?.service || "");
  const country = String(body?.country || "");

  if (!isPlausibleServiceCode(service)) {
    return json({ success: false, error: "Unknown service" }, 400);
  }
  if (!isPlausibleCountryCode(country)) {
    return json({ success: false, error: "Invalid country" }, 400);
  }

  const supabase = adminClient();
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "foreign_number_purchase",
    user.id,
    5,
    600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error:
        "Too many number requests. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  // Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({
      success: false,
      error: "Re-authorization required. Please try again.",
    }, 401);
  }

  // Re-fetch the live price ourselves — never trust a client-supplied price.
  let priceUSD: number;
  try {
    const p = await getServicePriceUSD(service, country);
    if (p === null || !isWithinPriceCap(p)) {
      return json({
        success: false,
        error: "No numbers currently available for this combination",
      });
    }
    priceUSD = p;
  } catch {
    return json({
      success: false,
      error: "Could not verify current price. Please try again.",
    });
  }

  const amountKobo = usdToNgnKobo(priceUSD);

  // Price-lock: never charge more than the price the user actually agreed to.
  // SMSPVA prices swing, so if the live rate rose above their quote, stop and
  // ask them to refresh — no surprise overcharge. (A drop just charges less.)
  const quotedKobo = Number(body.quoted_kobo);
  if (
    Number.isFinite(quotedKobo) && quotedKobo > 0 && amountKobo > quotedKobo
  ) {
    return json({
      success: false,
      price_changed: true,
      error:
        "The price changed since you last checked. Please refresh and try again.",
    });
  }

  const requestId = String(body.idempotency_key || newIdempotencyKey());
  const clientName = typeof body.service_name === "string"
    ? body.service_name.trim().slice(0, 60)
    : "";
  const serviceName = FOREIGN_NUMBER_SERVICES.find((s) =>
    s.id === service
  )?.name || clientName || service;

  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: amountKobo,
      p_type: "foreign_number",
      p_network: "N/A",
      p_recipient: `${serviceName} (${country})`,
      p_metadata: {
        service,
        service_name: serviceName,
        country,
        price_usd: priceUSD,
      },
      p_idempotency_key: requestId,
    },
  );

  if (debitError) {
    const msg = debitError.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient balance" });
    }
    if (msg.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "Wallet not found" });
    }
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  // The rented number itself is the paid-for good — complete on successful
  // rental. If a code never arrives the user is auto-refunded later (and, since
  // SMSPVA only charges us ON code delivery, a no-code rental costs us nothing).
  try {
    const result = await getNumber(service, country);

    if ("error" in result) {
      await supabase.rpc("refund_service_transaction", {
        p_tx_id: txId,
        p_reason: result.error,
      });
      return json({ success: false, error: humanizeSmspvaError(result.error) });
    }

    await supabase.rpc("complete_service_transaction", {
      p_tx_id: txId,
      p_order_id: result.activationId,
    });

    return json({
      success: true,
      transaction_id: txId,
      activation_id: result.activationId,
      phone_number: result.phoneNumber,
      service_name: serviceName,
      amount: amountKobo,
    });
  } catch (e) {
    const isAuthError = e instanceof SmspvaError;
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: isAuthError
        ? `smspva_config: ${e.message}`
        : "provider_unreachable",
    });
    return json({
      success: false,
      error: isAuthError
        ? "Provider not configured. Please try again later."
        : "Network error. Please try again. You were not charged.",
    });
  }
});

function humanizeSmspvaError(code: string): string {
  if (/no_number|no numbers|not available|no free|not found/i.test(code)) {
    return "No numbers currently available. Please try a different country.";
  }
  if (/balance|no_money/i.test(code)) {
    return "Service temporarily unavailable. Please try again later.";
  }
  if (/bad.?key|apikey/i.test(code)) {
    return "Provider configuration error. Please try again later.";
  }
  return "Purchase failed. You were not charged.";
}
