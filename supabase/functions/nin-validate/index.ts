import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  isServiceEnabled,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { getServicePriceKobo } from "../_shared/service-pricing.ts";
import {
  isNinBvnConfigured,
  NinBvnError,
  submitNinValidation,
} from "../_shared/ninbvn-client.ts";

// Retail price �?CheckMyNINBVN charges us �?,000/order (auto-refunded to us
// if NIMC rejects it). Adjust to whatever markup you want to charge users.
const NIN_VALIDATE_PRICE_KOBO = 800000; // ₦8,000

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function newRequestId(): string {
  return `ninval${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

// Confirms a NIN is genuinely issued/active in NIMC's database �?this is
// NOT instant like nin-verify. It's a reviewed order (24-48h turnaround);
// the transaction stays 'pending' until nin-reconcile's scheduled sweep
// polls the provider and resolves it.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isNinBvnConfigured()) {
    return json({ error: "NIN validation not configured" }, 500);
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

  const nin = String(body?.nin || "").trim();
  const dob = String(body?.date_of_birth || "").trim(); // expected YYYY-MM-DD
  if (!/^\d{11}$/.test(nin)) {
    return json({ success: false, error: "Enter a valid 11-digit NIN" }, 400);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) {
    return json({ success: false, error: "Enter a valid date of birth" }, 400);
  }

  const supabase = adminClient();
  if (!(await isServiceEnabled(supabase, "identity"))) {
    return json({
      success: false,
      error:
        "Identity services are temporarily unavailable. Please try again later.",
    }, 503);
  }
  if (!(await isServiceEnabled(supabase, "nin_modification"))) {
    return json({
      success: false,
      error:
        "NIN Validation is temporarily unavailable. Please check back later.",
    }, 503);
  }
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "nin_validate",
    user.id,
    4,
    3600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many validation attempts. Please wait and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({
      success: false,
      error: "Re-authorization required. Please try again.",
    }, 401);
  }

  const requestId = String(body.idempotency_key || newRequestId());
  const priceKobo = await getServicePriceKobo(supabase, "nin_validation", NIN_VALIDATE_PRICE_KOBO);

  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: priceKobo,
      p_type: "nin_validation",
      p_network: "N/A",
      p_recipient: nin,
      p_metadata: { service: "nin_validation", nin, date_of_birth: dob },
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

  try {
    const { status, data } = await submitNinValidation(nin, dob);
    const referenceId = data?.reference_id ?? data?.data?.reference_id;

    if (status >= 400 || !referenceId) {
      await confirmServiceRefund(supabase, txId, data?.message || "order_rejected", "automatic");
      return json({
        success: false,
        error: data?.message ||
          "Could not submit validation request. You were not charged.",
      });
    }

    // Stays 'pending' �?nin-reconcile resolves it once NIMC's review
    // completes. Store the reference_id so the sweep can poll it.
    await supabase
      .from("transactions")
      .update({
        metadata: {
          service: "nin_validation",
          nin,
          date_of_birth: dob,
          reference_id: referenceId,
        },
      })
      .eq("id", txId);

    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      message:
        "Validation submitted. This usually takes 24-48 hours — check Transaction History for the result.",
    });
  } catch (e) {
    const isConfigError = e instanceof NinBvnError;
    await confirmServiceRefund(
      supabase,
      txId,
      isConfigError ? `ninbvn_config: ${e.message}` : "provider_unreachable",
      "automatic",
    );
    return json({
      success: false,
      error: isConfigError
        ? "Provider not configured. Please try again later."
        : "Network error. Please try again. You were not charged.",
    });
  }
});
