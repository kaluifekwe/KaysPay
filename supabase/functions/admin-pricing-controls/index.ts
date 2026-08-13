import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const NETWORKS = ["mtn", "glo", "9mobile", "airtel"];
const SERVICE_KEYS = [
  "nin_verify_regular", "nin_verify_card", "nin_modification",
  "nin_validation", "bvn_verify_regular", "bvn_verify_card",
];
const CABLETV_PROVIDERS = ["gotv", "dstv", "startimes"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  let admin;
  try {
    admin = await requireAdmin(req, req.method === "POST" ? "super_admin" : "support");
  } catch (error) {
    if (error instanceof AdminAuthError) return json({ error: error.message }, error.status);
    return json({ error: "Unauthorized" }, 401);
  }
  const db = adminClient();

  if (req.method === "GET") {
    const [
      { data: plans, error: planError },
      { data: overrides, error: overrideError },
      { data: servicePricing, error: serviceError },
      { data: cabletvPlans, error: cabletvPlanError },
      { data: cabletvOverrides, error: cabletvOverrideError },
      { data: electricityFee, error: electricityFeeError },
    ] = await Promise.all([
      db.from("vtunaija_data_catalog")
        .select("id, network, family_key, family_name, name, validity, available, reseller_kobo")
        .order("network").order("family_name").order("name"),
      db.from("vtu_plan_price_overrides")
        .select("provider, network, plan_id, price_kobo, updated_at")
        .order("network"),
      db.from("service_pricing")
        .select("service_key, price_kobo, provider_cost_kobo, updated_at")
        .order("service_key"),
      db.from("vtunaija_cabletv_catalog")
        .select("id, provider, cabletv_plan_id, name, validity, available, reseller_kobo")
        .order("provider").order("name"),
      db.from("vtu_cabletv_price_overrides")
        .select("provider, plan_id, price_kobo, updated_at")
        .order("provider"),
      db.from("electricity_fee_config").select("fee_kobo, updated_at").eq("id", true).maybeSingle(),
    ]);
    if (planError || overrideError || serviceError || cabletvPlanError || cabletvOverrideError || electricityFeeError) {
      return json({ error: "Could not load pricing" }, 500);
    }
    return json({
      success: true,
      plans,
      price_overrides: overrides,
      service_pricing: servicePricing,
      cabletv_plans: cabletvPlans,
      cabletv_price_overrides: cabletvOverrides,
      electricity_fee: electricityFee,
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 2048);
  } catch (error) {
    const parsed = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: parsed.message }, parsed.status);
  }

  const target = String(body.target || "");

  if (target === "plan") {
    const network = String(body.network || "").toLowerCase();
    const planId = String(body.plan_id || "").trim().slice(0, 160);
    const clear = body.clear === true;
    if (!NETWORKS.includes(network) || !planId) return json({ error: "Invalid plan target" }, 400);

    const { data: planExists, error: planCheckError } = await db
      .from("vtunaija_data_catalog")
      .select("id").eq("id", planId).eq("network", network).limit(1).maybeSingle();
    if (planCheckError) return json({ error: "Could not verify the selected plan" }, 500);
    if (!planExists) return json({ error: "That plan no longer exists" }, 400);

    if (clear) {
      const { error } = await db.rpc("clear_vtu_plan_price", {
        p_admin_user_id: admin.userId, p_provider: "vtunaija", p_network: network, p_plan_id: planId,
      });
      if (error) return json({ error: "Could not clear the custom price" }, 500);
      return json({ success: true, cleared: true });
    }

    const priceKobo = Math.round(Number(body.price_kobo));
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) return json({ error: "Enter a valid price" }, 400);

    const { error } = await db.rpc("set_vtu_plan_price", {
      p_admin_user_id: admin.userId, p_provider: "vtunaija", p_network: network, p_plan_id: planId, p_price_kobo: priceKobo,
    });
    if (error) return json({ error: "Could not save the custom price" }, 500);
    return json({ success: true, price_kobo: priceKobo });
  }

  if (target === "service") {
    const serviceKey = String(body.service_key || "");
    if (!SERVICE_KEYS.includes(serviceKey)) return json({ error: "Invalid service" }, 400);

    const priceKobo = Math.round(Number(body.price_kobo));
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) return json({ error: "Enter a valid price" }, 400);

    let providerCostKobo: number | null = null;
    if (body.provider_cost_kobo !== undefined) {
      providerCostKobo = Math.round(Number(body.provider_cost_kobo));
      if (!Number.isFinite(providerCostKobo) || providerCostKobo < 0) {
        return json({ error: "Enter a valid provider cost" }, 400);
      }
    }

    const { error } = await db.rpc("set_service_price", {
      p_admin_user_id: admin.userId, p_service_key: serviceKey, p_price_kobo: priceKobo,
      p_provider_cost_kobo: providerCostKobo,
    });
    if (error) return json({ error: "Could not save the price" }, 500);
    return json({ success: true, price_kobo: priceKobo });
  }

  if (target === "cabletv") {
    const provider = String(body.provider || "").toLowerCase();
    const planId = String(body.plan_id || "").trim().slice(0, 160);
    const clear = body.clear === true;
    if (!CABLETV_PROVIDERS.includes(provider) || !planId) return json({ error: "Invalid bouquet target" }, 400);

    const { data: planExists, error: planCheckError } = await db
      .from("vtunaija_cabletv_catalog")
      .select("id").eq("provider", provider).eq("cabletv_plan_id", planId).limit(1).maybeSingle();
    if (planCheckError) return json({ error: "Could not verify the selected bouquet" }, 500);
    if (!planExists) return json({ error: "That bouquet no longer exists" }, 400);

    if (clear) {
      const { error } = await db.rpc("clear_cabletv_price", {
        p_admin_user_id: admin.userId, p_provider: provider, p_plan_id: planId,
      });
      if (error) return json({ error: "Could not clear the custom price" }, 500);
      return json({ success: true, cleared: true });
    }

    const priceKobo = Math.round(Number(body.price_kobo));
    if (!Number.isFinite(priceKobo) || priceKobo <= 0) return json({ error: "Enter a valid price" }, 400);

    const { error } = await db.rpc("set_cabletv_price", {
      p_admin_user_id: admin.userId, p_provider: provider, p_plan_id: planId, p_price_kobo: priceKobo,
    });
    if (error) return json({ error: "Could not save the custom price" }, 500);
    return json({ success: true, price_kobo: priceKobo });
  }

  if (target === "electricity_fee") {
    const feeKobo = Math.round(Number(body.fee_kobo));
    if (!Number.isFinite(feeKobo) || feeKobo < 0) return json({ error: "Enter a valid fee" }, 400);

    const { error } = await db.rpc("set_electricity_fee", {
      p_admin_user_id: admin.userId, p_fee_kobo: feeKobo,
    });
    if (error) return json({ error: "Could not save the fee" }, 500);
    return json({ success: true, fee_kobo: feeKobo });
  }

  return json({ error: "Invalid target" }, 400);
});
