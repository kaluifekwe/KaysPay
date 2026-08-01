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
import {
  AIRTIME_MAX,
  AIRTIME_MIN,
  BILL_MAX,
  BILL_MIN,
  DATA_BUNDLES,
  ELECTRICITY_PROVIDERS,
  EXAM_PIN_TYPES,
  KOBO,
  NetworkProvider,
  TV_BOUQUETS,
  VALID_NETWORKS,
} from "../_shared/vtu-catalog.ts";
import {
  callVTUNG,
  isVtuConfigured,
  NON_TERMINAL_STATUSES,
  SUCCESS_STATUSES,
  VTUAuthError,
} from "../_shared/vtu-client.ts";
import {
  callVTUAfrica,
  isVtuAfricaConfigured,
  normalizeVTUAfricaResult,
  queryVTUAfrica,
  VTUAfricaError,
  vtuAfricaOutcome,
} from "../_shared/vtuafrica-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newRequestId() {
  // VTU.ng caps request_id at 50 chars — this is well within that, and
  // doubles as our own idempotency key (one id, one meaning, everywhere).
  return `ksp_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

type Provider = "vtu_ng" | "vtuafrica";

// Performance telemetry is deliberately sampled and contains no customer or
// financial data. A stable hash keeps retries of one idempotent request in the
// same sample while avoiding Math.random() differences between invocations.
function shouldMeasure(requestId: string): boolean {
  let hash = 0;
  for (let i = 0; i < requestId.length; i++) hash = (hash * 31 + requestId.charCodeAt(i)) >>> 0;
  return hash % 10 === 0; // 10% sample: useful percentiles without a write per purchase.
}

/**
 * Resolve the trusted price + provider payload for a purchase request.
 * `amount` is in KOBO (used to debit the wallet). Amounts inside
 * `providerPayload` are in NAIRA because both providers expect naira.
 * Throws a string error code for invalid requests.
 *
 * Provider routing: VTUAfrica now handles every service — airtime, data (all
 * 4 networks), electricity, and TV — moved off VTU.ng by explicit choice.
 * Exam pins were already VTUAfrica-only (VTU.ng never had a working
 * integration for them).
 */
function resolvePurchase(body: any): {
  amount: number; // kobo
  txType: string;
  network: string;
  recipient: string | null;
  provider: Provider;
  endpoint: string;
  providerPayload: Record<string, unknown>;
} {
  const service = String(body?.service || "");

  switch (service) {
    case "airtime": {
      const network = String(body.network || "")
        .toLowerCase() as NetworkProvider;
      const amount = Number(body.amount); // kobo
      const phone = String(body.phone || "");
      if (!VALID_NETWORKS.includes(network)) throw "INVALID_NETWORK";
      if (!/^0\d{10}$/.test(phone)) throw "INVALID_PHONE";
      if (
        !Number.isInteger(amount) || amount < AIRTIME_MIN ||
        amount > AIRTIME_MAX
      ) throw "INVALID_AMOUNT";
      return {
        amount,
        txType: "airtime",
        network,
        recipient: phone,
        provider: "vtuafrica",
        endpoint: "/airtime",
        providerPayload: { network, phone, amount: amount / KOBO },
      };
    }

    case "data": {
      const network = String(body.network || "")
        .toLowerCase() as NetworkProvider;
      const phone = String(body.phone || "");
      const bundleId = String(body.bundle_id || "");
      if (!VALID_NETWORKS.includes(network)) throw "INVALID_NETWORK";
      if (!/^0\d{10}$/.test(phone)) throw "INVALID_PHONE";

      const bundle = DATA_BUNDLES[bundleId];
      if (!bundle || bundle.network !== network) throw "INVALID_BUNDLE";
      return {
        amount: bundle.amount, // kobo
        txType: "data",
        network,
        recipient: phone,
        provider: "vtuafrica",
        endpoint: "/data",
        providerPayload: {
          MobileNumber: phone,
          service: bundle.serviceCode,
          DataPlan: bundle.planCode,
          maxamount: bundle.amount / KOBO,
        },
      };
    }

    case "electricity": {
      const biller = String(body.provider_id || "");
      const meter = String(body.meter_number || "");
      const amount = Number(body.amount); // kobo
      const type = body.type === "postpaid" ? "postpaid" : "prepaid";
      if (!ELECTRICITY_PROVIDERS.includes(biller)) throw "INVALID_PROVIDER";
      if (!/^\d{6,20}$/.test(meter)) throw "INVALID_METER";
      if (!Number.isInteger(amount) || amount < BILL_MIN || amount > BILL_MAX) {
        throw "INVALID_AMOUNT";
      }
      return {
        amount,
        txType: "bill",
        network: "N/A",
        recipient: meter,
        provider: "vtuafrica",
        endpoint: "/electric",
        providerPayload: {
          service: biller,
          meterNo: meter,
          metertype: type,
          amount: amount / KOBO,
        },
      };
    }

    case "tv": {
      const bouquetId = String(body.bouquet_id || "");
      const smartcard = String(body.smartcard_number || "");
      const bouquet = TV_BOUQUETS[bouquetId];
      if (!bouquet) throw "INVALID_BOUQUET";
      if (!/^\d{6,20}$/.test(smartcard)) throw "INVALID_SMARTCARD";
      return {
        amount: bouquet.amount, // kobo
        txType: "bill",
        network: "N/A",
        recipient: smartcard,
        provider: "vtuafrica",
        endpoint: "/paytv",
        providerPayload: {
          service: bouquet.serviceId,
          smartNo: smartcard,
          variation: bouquet.variationCode,
          maxamount: bouquet.amount / KOBO,
        },
      };
    }

    case "exam_pin": {
      const examId = String(body.exam_id || "");
      const quantity = Number(body.quantity);
      const exam = EXAM_PIN_TYPES[examId];
      if (!exam) throw "INVALID_EXAM_TYPE";
      if (!exam.quantityOptions.includes(quantity)) throw "INVALID_QUANTITY";

      const providerPayload: Record<string, unknown> = {
        service: exam.serviceCode,
        product_code: exam.productCode,
        quantity,
      };

      if (exam.requiresProfileCode) {
        const profileCode = String(body.profile_code || "").trim();
        if (!profileCode) throw "INVALID_PROFILE_CODE";
        providerPayload.profilecode = profileCode;
      }

      return {
        amount: exam.amount * quantity, // kobo
        txType: "exam_pin",
        network: "N/A",
        recipient: null,
        provider: "vtuafrica",
        endpoint: "/exam-pin",
        providerPayload,
      };
    }

    default:
      throw "UNKNOWN_SERVICE";
  }
}

// Turn the internal validation codes thrown by resolvePurchase into clear,
// user-facing sentences — the client shows this text directly, so it must
// never be a raw code like "INVALID_PHONE".
const VALIDATION_MESSAGES: Record<string, string> = {
  INVALID_NETWORK: "Please choose a valid network.",
  INVALID_PHONE: "Please enter a valid phone number.",
  INVALID_AMOUNT: "Please enter a valid amount.",
  INVALID_BUNDLE: "Please choose a valid data bundle.",
  INVALID_PROVIDER: "Please choose a valid provider.",
  INVALID_METER: "Please enter a valid meter number.",
  INVALID_BOUQUET: "Please choose a valid package.",
  INVALID_SMARTCARD: "Please enter a valid smartcard number.",
  INVALID_EXAM_TYPE: "Please choose a valid exam type.",
  INVALID_QUANTITY: "Please choose a valid quantity.",
  INVALID_PROFILE_CODE: "Please enter your JAMB profile code.",
  UNKNOWN_SERVICE: "This service isn't available right now.",
};
function friendlyValidation(code: string): string {
  return VALIDATION_MESSAGES[code] ||
    "Please check your details and try again.";
}

console.info("[build] phase5-financial-controls-20260801");

serve(async (req: Request) => {
  const requestStartedAt = performance.now();
  const cors = handleCors(req);
  if (cors) return cors;

  // 1. Authenticate from the JWT — never trust a client-sent user id.
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

  const supabase = adminClient();
  if (!(await isServiceEnabled(supabase, "vtu"))) {
    return json({
      success: false,
      error: "This service is temporarily unavailable. Please try again later.",
    }, 503);
  }
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "vtu_purchase",
    user.id,
    30,
    300,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error:
        "Too many purchase attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  // 2. Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({
      success: false,
      error: "Re-authorization required. Please try again.",
    }, 401);
  }

  // 3. Resolve trusted price + provider payload.
  let plan;
  try {
    plan = resolvePurchase(body);
  } catch (code) {
    return json({ error: friendlyValidation(String(code)) }, 400);
  }

  if (plan.provider === "vtu_ng" && !isVtuConfigured()) {
    return json({ error: "VTU provider not configured" }, 500);
  }
  if (plan.provider === "vtuafrica" && !isVtuAfricaConfigured()) {
    return json({ error: "VTUAfrica provider not configured" }, 500);
  }

  // 3b. Duplicate guard (data + TV only). The telco/VTUAfrica rejects a repeat
  // of the SAME plan to the SAME recipient within a short window, which would
  // otherwise become a confusing debit -> provider-reject -> refund. Catch it
  // here and tell the user plainly. Airtime/electricity/exam allow legitimate
  // repeats, so they're excluded.
  if (body.service === "data" || body.service === "tv") {
    const dupSince = new Date(Date.now() - 3 * 60 * 1000).toISOString();
    const { data: recentSame } = await supabase
      .from("transactions")
      .select("metadata")
      .eq("user_id", user.id)
      .eq("type", plan.txType)
      .eq("recipient_phone", plan.recipient)
      .in("status", ["completed", "pending"])
      .gte("created_at", dupSince)
      .limit(5);
    const pp = plan.providerPayload as Record<string, unknown>;
    const isSamePlan = (recentSame ?? []).some((t) => {
      const req =
        ((t.metadata as Record<string, unknown>)?.request ?? {}) as Record<
          string,
          unknown
        >;
      return body.service === "data"
        ? req.service === pp.service && req.DataPlan === pp.DataPlan
        : req.service === pp.service && req.variation === pp.variation;
    });
    if (isSamePlan) {
      return json({
        success: false,
        error:
          "You just bought this plan for this number. Please wait a couple of minutes before buying it again.",
      });
    }
  }

  const requestId = String(body.idempotency_key || newRequestId());

  // 4. Atomically debit + create the pending transaction.
  const debitStartedAt = performance.now();
  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: plan.amount,
      p_type: plan.txType,
      p_network: plan.network,
      p_recipient: plan.recipient,
      p_metadata: { service: body.service, request: plan.providerPayload },
      p_idempotency_key: requestId,
    },
  );
  const debitCompletedAt = performance.now();

  if (debitError) {
    const msg = debitError.message || "";
    // Expected business outcomes return 200 + success:false so the client
    // can read them directly; only genuine faults return non-2xx.
    if (msg.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient balance" });
    }
    if (msg.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "Wallet not found" });
    }
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  // 4a. VTUAfrica — orders can be async. Some services (betting confirmed,
  // likely bill-type payments) return "Processing": accepted + our merchant
  // wallet charged, but not settled. Those must be held 'pending' (NOT
  // refunded) and finalized by the vtuafrica-reconcile sweep — same lifecycle
  // as VTU.ng below. Refunding a "Processing" order is a money leak.
  if (plan.provider === "vtuafrica") {
    const measureThisRequest =
      (body.service === "airtime" || body.service === "data") && shouldMeasure(requestId);
    let providerStartedAt = 0;
    let providerCompletedAt = 0;
    // VTUAfrica's purchase endpoint is synchronous and slow (measured 2-13s in
    // production — it holds the connection open while it reaches the telco).
    // The settle logic below is UNCHANGED (same debit/complete/refund
    // semantics); it's just wrapped in a function so airtime/data can stop
    // blocking the user for the whole call. Every branch returns a Response.
    const settle = async (): Promise<Response> => {
      try {
        providerStartedAt = performance.now();
        const result = await callVTUAfrica(plan.endpoint, {
          ...plan.providerPayload,
          ref: requestId,
        });
        providerCompletedAt = performance.now();
        const outcome = vtuAfricaOutcome(result);

        if (outcome === "success") {
          const orderId: string | undefined = result?.description?.ReferenceID;
          const { error: completeError } = await supabase.rpc(
            "complete_service_transaction",
            {
              p_tx_id: txId,
              p_order_id: orderId ?? null,
            },
          );
          if (completeError) throw completeError;

          // The prepaid meter token was previously only ever returned in this
          // one-time response and never saved anywhere — closing the app
          // without downloading/copying it meant it was gone for good, with
          // no way to regenerate the receipt from Transaction History later.
          // Persist it into the transaction's own metadata (a short string,
          // not a file — this is not the same as storing a generated PDF,
          // which is still never done) so the receipt can be rebuilt anytime.
          const electricityToken: string | undefined = result?.description
            ?.Token;

          // Exam PINs come back as a single "<=>"-delimited string for
          // multi-quantity purchases (VTUAfrica's own docs example:
          // "WR23454<=>456786564") — split into a clean array for the client.
          const pinsRaw: string | undefined = result?.description?.pins;
          const pins = pinsRaw
            ? pinsRaw.split("<=>").filter(Boolean)
            : undefined;

          // Persist the token, exam PIN(s) AND the provider reference — all
          // one-time values in the provider response. Saving them means they're
          // never lost: the meter receipt / exam PIN(s) can always be re-read
          // from Transaction History, even if the app was closed on the result
          // screen. The order_id matters more now that the result screen learns
          // this outcome by POLLING the transaction row (the provider call runs
          // in the background) rather than from this response directly — the
          // poll rebuilds the receipt from metadata, so the reference must live
          // there too, not only in the response body below.
          if (electricityToken || pins || orderId) {
            await supabase
              .from("transactions")
              .update({
                metadata: {
                  service: body.service,
                  request: plan.providerPayload,
                  ...(electricityToken ? { token: electricityToken } : {}),
                  ...(pins ? { pins } : {}),
                  ...(orderId ? { order_id: orderId } : {}),
                },
              })
              .eq("id", txId);
          }

          return json({
            success: true,
            transaction_id: txId,
            order_id: orderId,
            pins,
            // Present only for electricity (prepaid meter token).
            token: electricityToken,
            amount: plan.amount,
          });
        }

        if (outcome === "pending" || outcome === "unknown") {
          // Accepted but not settled — leave 'pending' (its default state),
          // don't refund. vtuafrica-reconcile requeries by ref and finalizes.
          return json({
            success: true,
            pending: true,
            transaction_id: txId,
            message:
              "Your order is still processing. You'll be notified once it completes.",
          });
        }

        // outcome === "failed": explicit failure or hard reject — refund.
        const verified = await queryVTUAfrica(requestId);
        const verifiedOutcome = vtuAfricaOutcome(verified);

        if (verifiedOutcome === "success") {
          const normalized = normalizeVTUAfricaResult(verified);
          const { error: completeError } = await supabase.rpc(
            "complete_service_transaction",
            {
              p_tx_id: txId,
              p_order_id: normalized.reference,
            },
          );
          if (completeError) throw completeError;
          return json({
            success: true,
            transaction_id: txId,
            order_id: normalized.reference ?? undefined,
            amount: plan.amount,
          });
        }

        if (verifiedOutcome === "failed") {
          const normalized = normalizeVTUAfricaResult(verified);
          await supabase
            .from("transactions")
            .update({
              metadata: {
                service: body.service,
                request: plan.providerPayload,
                idempotency_key: requestId,
                provider_failure_observation: {
                  at: new Date().toISOString(),
                  status: normalized.status,
                  message: normalized.message,
                },
              },
            })
            .eq("id", txId)
            .eq("status", "pending");
        }

        return json({
          success: true,
          pending: true,
          transaction_id: txId,
          message:
            "Your order is still processing. You'll be notified once it completes.",
        });
      } catch (e) {
        // A config/auth error means the request never reached VTUAfrica —
        // nothing was charged, so refunding is safe. But a generic network
        // error is ambiguous: the request may have reached VTUAfrica and
        // charged our merchant wallet, with only the RESPONSE lost. Refunding
        // in that case is a money leak, so we hold 'pending' and let
        // vtuafrica-reconcile settle it by querying the ref.
        if (e instanceof VTUAfricaError) {
          await supabase.rpc("refund_service_transaction", {
            p_tx_id: txId,
            p_reason: `vtuafrica_config: ${e.message}`,
          });
          return json({
            success: false,
            error: "Provider not configured. Please try again later.",
          });
        }
        return json({
          success: true,
          pending: true,
          transaction_id: txId,
          message:
            "Your order is still processing. You'll be notified once it completes.",
        });
      }
    };

    // Await the provider call fully before responding. The worker MUST stay
    // alive until the airtime/data order actually settles.
    //
    // Do NOT return early and finish the provider call in the background via
    // EdgeRuntime.waitUntil: this runtime EarlyDrops the worker the instant the
    // response is sent (confirmed 2026-07-30 via a Shutdown log, reason
    // "EarlyDrop", cpu_time 49ms), which kills the in-flight VTUAfrica call —
    // leaving the user DEBITED WITH NO AIRTIME and the transaction stuck
    // 'pending' until reconcile. Keeping the request in-flight (awaiting settle)
    // is what guarantees the provider call completes; the worker isn't dropped
    // while a request is still open.
    //
    // The result screen shows "Processing" with a spinner while this resolves
    // (~2-13s, the provider's own latency) and then flips to Successful/Failed.
    // Genuinely async provider "Processing" replies are still held 'pending'
    // inside settle() and finalized by vtuafrica-reconcile.
    const response = await settle();

    if (measureThisRequest) {
      const finishedAt = performance.now();
      let outcome = "error";
      try {
        const responseBody = await response.clone().json();
        outcome = responseBody?.pending
          ? "pending"
          : responseBody?.success
            ? "completed"
            : "failed";
      } catch {
        // Keep the generic outcome; telemetry must never affect the purchase.
      }

      const providerEnd = providerCompletedAt || finishedAt;
      const { error: metricError } = await supabase.from("vtu_performance_metrics").upsert({
        transaction_id: txId,
        service: body.service,
        network: plan.network,
        provider: plan.provider,
        outcome,
        pre_debit_ms: Math.round(debitStartedAt - requestStartedAt),
        debit_ms: Math.round(debitCompletedAt - debitStartedAt),
        provider_ms: Math.round(providerEnd - (providerStartedAt || debitCompletedAt)),
        settlement_ms: providerCompletedAt ? Math.round(finishedAt - providerCompletedAt) : 0,
        total_ms: Math.round(finishedAt - requestStartedAt),
      }, { onConflict: "transaction_id" });
      if (metricError) {
        // Non-sensitive structured failure only. Telemetry is best-effort and
        // must never alter or delay financial settlement beyond this one write.
        console.warn("vtu_performance_metric_write_failed", metricError.code);
      }
    }

    return response;
  }

  // 4b. VTU.ng — call the provider with the SERVER-SIDE token.
  try {
    const result = await callVTUNG(supabase, plan.endpoint, {
      request_id: requestId,
      ...plan.providerPayload,
    });

    // A hard API-level error (not even an order was created) — code is the
    // error code itself (e.g. "invalid_service_id"), not "success".
    if (result?.code !== "success") {
      await supabase.rpc("refund_service_transaction", {
        p_tx_id: txId,
        p_reason: result?.message || result?.code || "provider_rejected",
      });
      return json({
        success: false,
        error: result?.message || "Purchase failed. You were not charged.",
      });
    }

    // v2 orders can be async: "code":"success" just means the request was
    // accepted — the real outcome is in data.status. Some providers deliver
    // via USSD/SMS on VTU.ng's side and can genuinely take minutes, which no
    // amount of polling here speeds up — so don't make the user wait for it.
    // Respond immediately with what we know; the scheduled vtu-reconcile
    // sweep finishes anything still processing within a few minutes.
    const order = result.data;

    if (SUCCESS_STATUSES.includes(order?.status)) {
      await supabase.rpc("complete_service_transaction", {
        p_tx_id: txId,
        p_order_id: order?.order_id ?? null,
      });
      return json({
        success: true,
        transaction_id: txId,
        order_id: order?.order_id,
        token: order?.token,
        units: order?.units,
        amount: plan.amount,
      });
    }

    if (NON_TERMINAL_STATUSES.includes(order?.status)) {
      // Still not resolved — leave the transaction 'pending' (its default
      // state) rather than guess. VTU.ng's webhook does NOT fire for normal
      // automated completions (only admin-forced completions and refunds),
      // so this gets finalized by the scheduled vtu-reconcile sweep instead.
      return json({
        success: true,
        pending: true,
        transaction_id: txId,
        message:
          "Your order is still processing. You'll be notified once it completes.",
      });
    }

    // Anything else (refunded, failed, cancelled) — refund our side too.
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: order?.status || "provider_rejected",
    });
    return json({
      success: false,
      error: "Purchase failed. You were not charged.",
    });
  } catch (e) {
    const isAuthError = e instanceof VTUAuthError;
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: isAuthError
        ? `vtu_auth_failed: ${e.message}`
        : "provider_unreachable",
    });
    return json({
      success: false,
      error: isAuthError
        ? `VTU.ng login failed: ${e.message}`
        : "Network error. Please try again. You were not charged.",
    });
  }
});
