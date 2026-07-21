import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";
import { browseAiraloPackages, submitAiraloOrder, isAiraloConfigured, AiraloAuthError } from "../_shared/airalo-client.ts";
import { usdToNgnKobo, getUsdNgnRate } from "../_shared/esim-catalog.ts";

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
  country: string,
): Promise<{ priceUSD: number; raw: any } | null> {
  const raw = await browseAiraloPackages(supabase, country);
  for (const c of raw?.data || []) {
    for (const op of c?.operators || []) {
      for (const pkg of op?.packages || []) {
        if (pkg?.id === providerPackageId) {
          const priceUSD = Number(pkg?.prices?.net_price?.USD ?? pkg?.net_price ?? pkg?.price);
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
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const planId = String(body?.plan_id || "");
  const country = String(body?.country || "").toUpperCase();
  const [provider, providerPackageId] = planId.split(/:(.+)/);

  if (!/^[A-Z]{2}$/.test(country)) return json({ success: false, error: "Invalid country code" }, 400);
  if (provider !== "airalo") return json({ success: false, error: "Invalid plan" }, 400);
  if (!providerPackageId) return json({ success: false, error: "Invalid plan" }, 400);
  if (!isAiraloConfigured()) return json({ error: "Airalo not configured" }, 500);

  const supabase = adminClient();

  // Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) return json({ success: false, error: "Re-authorization required. Please try again." }, 401);

  let current;
  try {
    current = await resolveCurrentPrice(supabase, providerPackageId, country);
  } catch {
    return json({ success: false, error: "Could not verify current plan price. Please try again." });
  }
  if (!current) return json({ success: false, error: "This plan is no longer available. Please pick another." });

  const fxRate = await getUsdNgnRate(supabase);
  const amountKobo = usdToNgnKobo(current.priceUSD, fxRate);
  const requestId = String(body.idempotency_key || newIdempotencyKey());

  const { data: txId, error: debitError } = await supabase.rpc("debit_for_service", {
    p_user_id: user.id,
    p_amount: amountKobo,
    p_type: "esim",
    p_network: "N/A",
    p_recipient: country,
    p_metadata: { service: "esim", provider, provider_package_id: providerPackageId, country, price_usd: current.priceUSD, fx_rate: fxRate },
    p_idempotency_key: requestId,
  });

  if (debitError) {
    const msg = debitError.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) return json({ success: false, error: "Insufficient balance" });
    if (msg.includes("WALLET_NOT_FOUND")) return json({ success: false, error: "Wallet not found" });
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  try {
    const result = await submitAiraloOrder(supabase, providerPackageId, 1, requestId);
    const sim = result?.data?.sims?.[0];
    if (!sim?.qrcode) {
      await supabase.rpc("refund_service_transaction", { p_tx_id: txId, p_reason: result?.meta?.message || "provider_rejected" });
      return json({ success: false, error: result?.meta?.message || "Purchase failed. You were not charged." });
    }
    await supabase.rpc("complete_service_transaction", { p_tx_id: txId, p_order_id: String(result?.data?.id ?? "") });
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
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: isAuthError ? `airalo_auth_failed: ${e.message}` : "provider_unreachable",
    });
    return json({
      success: false,
      error: isAuthError ? "Provider login failed. Please try again later." : "Network error. Please try again. You were not charged.",
    });
  }
});
