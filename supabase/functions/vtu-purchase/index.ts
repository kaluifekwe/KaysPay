import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";
import {
  AIRTIME_MIN,
  AIRTIME_MAX,
  BILL_MIN,
  BILL_MAX,
  DATA_BUNDLES,
  TV_BOUQUETS,
  ELECTRICITY_PROVIDERS,
  VALID_NETWORKS,
  VALID_BETTING_IDS,
  BETTING_MIN,
  BETTING_MAX,
  EXAM_PIN_TYPES,
  KOBO,
  NetworkProvider,
} from "../_shared/vtu-catalog.ts";
import {
  callVTUNG,
  isVtuConfigured,
  VTUAuthError,
  NON_TERMINAL_STATUSES,
  SUCCESS_STATUSES,
} from "../_shared/vtu-client.ts";
import { callVTUAfrica, isVtuAfricaConfigured, isVtuAfricaSuccess, VTUAfricaError } from "../_shared/vtuafrica-client.ts";

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

/**
 * Resolve the trusted price + provider payload for a purchase request.
 * `amount` is in KOBO (used to debit the wallet). Amounts inside
 * `providerPayload` are in NAIRA because both providers expect naira.
 * Throws a string error code for invalid requests.
 *
 * Provider routing: VTUAfrica now handles every service — airtime, data (all
 * 4 networks), electricity, and TV — moved off VTU.ng by explicit choice.
 * Betting and exam pins were already VTUAfrica-only (VTU.ng never had a
 * working integration for either).
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
      const network = String(body.network || "").toLowerCase() as NetworkProvider;
      const amount = Number(body.amount); // kobo
      const phone = String(body.phone || "");
      if (!VALID_NETWORKS.includes(network)) throw "INVALID_NETWORK";
      if (!/^0\d{10}$/.test(phone)) throw "INVALID_PHONE";
      if (!Number.isInteger(amount) || amount < AIRTIME_MIN || amount > AIRTIME_MAX) throw "INVALID_AMOUNT";
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
      const network = String(body.network || "").toLowerCase() as NetworkProvider;
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
      if (!Number.isInteger(amount) || amount < BILL_MIN || amount > BILL_MAX) throw "INVALID_AMOUNT";
      return {
        amount,
        txType: "bill",
        network: "N/A",
        recipient: meter,
        provider: "vtuafrica",
        endpoint: "/electric",
        providerPayload: { service: biller, meterNo: meter, metertype: type, amount: amount / KOBO },
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

    case "betting": {
      const providerId = String(body.provider_id || "");
      const customerId = String(body.customer_id || "").trim();
      const amount = Number(body.amount); // kobo
      if (!VALID_BETTING_IDS.includes(providerId)) throw "INVALID_PROVIDER";
      if (!customerId) throw "INVALID_CUSTOMER_ID";
      if (!Number.isInteger(amount) || amount < BETTING_MIN || amount > BETTING_MAX) throw "INVALID_AMOUNT";
      return {
        amount,
        txType: "bill",
        network: "N/A",
        recipient: customerId,
        provider: "vtuafrica",
        endpoint: "/betpay",
        providerPayload: { userid: customerId, service: providerId, amount: amount / KOBO },
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

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // 1. Authenticate from the JWT — never trust a client-sent user id.
  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const supabase = adminClient();

  // 2. Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) return json({ success: false, error: "Re-authorization required. Please try again." }, 401);

  // 3. Resolve trusted price + provider payload.
  let plan;
  try {
    plan = resolvePurchase(body);
  } catch (code) {
    return json({ error: String(code) }, 400);
  }

  if (plan.provider === "vtu_ng" && !isVtuConfigured()) return json({ error: "VTU provider not configured" }, 500);
  if (plan.provider === "vtuafrica" && !isVtuAfricaConfigured()) return json({ error: "VTUAfrica provider not configured" }, 500);

  const requestId = String(body.idempotency_key || newRequestId());

  // 4. Atomically debit + create the pending transaction.
  const { data: txId, error: debitError } = await supabase.rpc("debit_for_service", {
    p_user_id: user.id,
    p_amount: plan.amount,
    p_type: plan.txType,
    p_network: plan.network,
    p_recipient: plan.recipient,
    p_metadata: { service: body.service, request: plan.providerPayload },
    p_idempotency_key: requestId,
  });

  if (debitError) {
    const msg = debitError.message || "";
    // Expected business outcomes return 200 + success:false so the client
    // can read them directly; only genuine faults return non-2xx.
    if (msg.includes("INSUFFICIENT_FUNDS")) return json({ success: false, error: "Insufficient balance" });
    if (msg.includes("WALLET_NOT_FOUND")) return json({ success: false, error: "Wallet not found" });
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  // 4a. VTUAfrica — synchronous API (no async order lifecycle), so this
  // either completes or refunds immediately, no pending/reconcile path.
  if (plan.provider === "vtuafrica") {
    try {
      const result = await callVTUAfrica(plan.endpoint, { ...plan.providerPayload, ref: requestId });

      if (isVtuAfricaSuccess(result)) {
        await supabase.rpc("complete_service_transaction", {
          p_tx_id: txId,
          p_order_id: result?.description?.ReferenceID ?? null,
        });
        // Exam PINs come back as a single "<=>"-delimited string for
        // multi-quantity purchases (VTUAfrica's own docs example:
        // "WR23454<=>456786564") — split into a clean array for the client.
        const pinsRaw: string | undefined = result?.description?.pins;
        const pins = pinsRaw ? pinsRaw.split("<=>").filter(Boolean) : undefined;
        return json({
          success: true,
          transaction_id: txId,
          order_id: result?.description?.ReferenceID,
          pins,
          // Present only for electricity (prepaid meter token).
          token: result?.description?.Token,
          amount: plan.amount,
        });
      }

      await supabase.rpc("refund_service_transaction", {
        p_tx_id: txId,
        p_reason: result?.description?.message || result?.description?.Status || "provider_rejected",
      });
      return json({ success: false, error: result?.description?.message || "Purchase failed. You were not charged." });
    } catch (e) {
      const isAuthError = e instanceof VTUAfricaError;
      await supabase.rpc("refund_service_transaction", {
        p_tx_id: txId,
        p_reason: isAuthError ? `vtuafrica_config: ${e.message}` : "provider_unreachable",
      });
      return json({
        success: false,
        error: isAuthError ? "Provider not configured. Please try again later." : "Network error. Please try again. You were not charged.",
      });
    }
  }

  // 4b. VTU.ng — call the provider with the SERVER-SIDE token.
  try {
    const result = await callVTUNG(supabase, plan.endpoint, { request_id: requestId, ...plan.providerPayload });

    // A hard API-level error (not even an order was created) — code is the
    // error code itself (e.g. "invalid_service_id"), not "success".
    if (result?.code !== "success") {
      await supabase.rpc("refund_service_transaction", {
        p_tx_id: txId,
        p_reason: result?.message || result?.code || "provider_rejected",
      });
      return json({ success: false, error: result?.message || "Purchase failed. You were not charged." });
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
        message: "Your order is still processing. You'll be notified once it completes.",
      });
    }

    // Anything else (refunded, failed, cancelled) — refund our side too.
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: order?.status || "provider_rejected",
    });
    return json({ success: false, error: "Purchase failed. You were not charged." });
  } catch (e) {
    const isAuthError = e instanceof VTUAuthError;
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: isAuthError ? `vtu_auth_failed: ${e.message}` : "provider_unreachable",
    });
    return json({
      success: false,
      error: isAuthError
        ? `VTU.ng login failed: ${e.message}`
        : "Network error. Please try again. You were not charged.",
    });
  }
});
