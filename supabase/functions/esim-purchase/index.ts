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
import {
  AiraloAuthError,
  browseAiraloPackages,
  fetchAiraloCatalog,
  isAiraloConfigured,
  submitAiraloOrder,
} from "../_shared/airalo-client.ts";
import { getUsdNgnRate, usdToNgnKobo } from "../_shared/esim-catalog.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newIdempotencyKey() {
  return `esim_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * Re-fetches the CURRENT live price for a specific package straight from
 * the provider — the client only ever sends an opaque plan id, never a
 * price. This is the same "never trust client-supplied price" principle as
 * every other purchase in this app, just applied to a live-fetched catalog
 * instead of a static one (there's no static eSIM catalog — 100+ countries
 * with several plans each isn't practical to hardcode).
 */
async function resolveCurrentPrice(
  supabase: ReturnType<typeof adminClient>,
  providerPackageId: string,
  scope: { country: string | null; region: string | null },
): Promise<{ priceUSD: number; raw: any } | null> {
  // A local package is re-priced from its country's catalogue; a regional /
  // worldwide package from the global catalogue.
  const raw = scope.region
    ? await fetchAiraloCatalog(supabase, "global")
    : await browseAiraloPackages(supabase, scope.country as string);
  for (const c of raw?.data || []) {
    for (const op of c?.operators || []) {
      for (const pkg of op?.packages || []) {
        if (pkg?.id === providerPackageId) {
          const priceUSD = Number(
            pkg?.prices?.net_price?.USD ?? pkg?.net_price ?? pkg?.price,
          );
          if (Number.isFinite(priceUSD)) return { priceUSD, raw: pkg };
        }
      }
    }
  }
  return null;
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

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

  const planId = String(body?.plan_id || "");
  const region = String(body?.region || "").trim();
  const country = String(body?.country || "").toUpperCase();
  const destination = region || country;
  const [provider, providerPackageId] = planId.split(/:(.+)/);

  if (!region && !/^[A-Z]{2}$/.test(country)) {
    return json({ success: false, error: "Invalid destination" }, 400);
  }
  if (provider !== "airalo") {
    return json({ success: false, error: "Invalid plan" }, 400);
  }
  if (!providerPackageId) {
    return json({ success: false, error: "Invalid plan" }, 400);
  }
  if (!isAiraloConfigured()) {
    return json({ error: "Airalo not configured" }, 500);
  }

  const supabase = adminClient();
  if (!(await isServiceEnabled(supabase, "esim"))) {
    return json({
      success: false,
      error:
        "eSIM purchases are temporarily unavailable. Please try again later.",
    }, 503);
  }
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "esim_purchase",
    user.id,
    6,
    600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many eSIM purchase attempts. Please wait and try again.",
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

  let current;
  try {
    current = await resolveCurrentPrice(supabase, providerPackageId, {
      country: region ? null : country,
      region: region || null,
    });
  } catch {
    return json({
      success: false,
      error: "Could not verify current plan price. Please try again.",
    });
  }
  if (!current) {
    return json({
      success: false,
      error: "This plan is no longer available. Please pick another.",
    });
  }

  const fxRate = await getUsdNgnRate(supabase);
  const amountKobo = usdToNgnKobo(current.priceUSD, fxRate);
  const requestId = String(body.idempotency_key || newIdempotencyKey());

  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: amountKobo,
      p_type: "esim",
      p_network: "N/A",
      p_recipient: destination,
      p_metadata: {
        service: "esim",
        provider,
        provider_package_id: providerPackageId,
        country: destination,
        region: region || null,
        price_usd: current.priceUSD,
        fx_rate: fxRate,
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

  try {
    const result = await submitAiraloOrder(
      supabase,
      providerPackageId,
      1,
      requestId,
    );
    const orderData = result?.data;
    const sim = orderData?.sims?.[0];
    if (!sim?.qrcode) {
      await confirmServiceRefund(supabase, txId, result?.meta?.message || "provider_rejected", "automatic");
      return json({
        success: false,
        error: result?.meta?.message ||
          "Purchase failed. You were not charged.",
      });
    }
    await supabase.rpc("complete_service_transaction", {
      p_tx_id: txId,
      p_order_id: String(orderData?.id ?? ""),
    });

    // Enrich the transaction metadata (service role, metadata only — no money
    // columns touched). Two purposes: (a) persist the delivered eSIM so the
    // customer can re-open its QR any time from Transaction History — the
    // order response is the ONLY place these appear; (b) record our REAL
    // Airalo cost (after the 20% reseller discount) for postpaid-invoice
    // reconciliation and true-margin reporting.
    await supabase
      .from("transactions")
      .update({
        metadata: {
          service: "esim",
          provider,
          provider_package_id: providerPackageId,
          country: destination,
          region: region || null,
          price_usd: current.priceUSD,
          fx_rate: fxRate,
          // What the customer bought (shown in "My eSIMs"):
          plan_name: current.raw?.title ?? null,
          plan_days: current.raw?.day ?? null,
          plan_data_mb: current.raw?.is_unlimited
            ? null
            : (current.raw?.amount ?? null),
          plan_unlimited: !!current.raw?.is_unlimited,
          // The eSIM itself (for later retrieval):
          iccid: sim.iccid ?? null,
          qrcode: sim.qrcode ?? null,
          qrcode_url: sim.qrcode_url ?? null,
          apple_install_url: sim.direct_apple_installation_url ?? null,
          // Our true cost from Airalo (postpaid reconciliation):
          airalo_order_code: orderData?.code ?? null,
          airalo_total_paid_usd: orderData?.total_amount_paid ?? null,
          airalo_unit_paid_usd: orderData?.unit_paid_price ?? null,
          airalo_discount_percent: orderData?.discount_percentage ?? null,
        },
      })
      .eq("id", txId);

    return json({
      success: true,
      transaction_id: txId,
      iccid: sim.iccid,
      qrcode: sim.qrcode,
      qrcode_url: sim.qrcode_url,
      direct_apple_installation_url: sim.direct_apple_installation_url,
      amount: amountKobo,
    });
  } catch (e) {
    const isAuthError = e instanceof AiraloAuthError;
    await confirmServiceRefund(
      supabase,
      txId,
      isAuthError ? `airalo_auth_failed: ${e.message}` : "provider_unreachable",
      "automatic",
    );
    return json({
      success: false,
      error: isAuthError
        ? "Provider login failed. Please try again later."
        : "Network error. Please try again. You were not charged.",
    });
  }
});
