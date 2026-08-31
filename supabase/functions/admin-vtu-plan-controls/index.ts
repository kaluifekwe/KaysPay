import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

const NETWORKS = ["mtn", "glo", "9mobile", "airtel"];
const SCOPES = ["network", "family", "plan"];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders(), "Content-Type": "application/json" } });
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
    const [{ data: plans, error: planError }, { data: controls, error: controlError }] = await Promise.all([
      db.from("vtunaija_data_catalog")
        .select("id, network, family_key, family_name, name, validity, available")
        .order("network").order("family_name").order("name"),
      db.from("vtu_plan_controls")
        .select("provider, network, scope_type, scope_value, enabled, reason, source, updated_at")
        .order("network").order("scope_type").order("scope_value"),
    ]);
    if (planError || controlError) return json({ error: "Could not load data availability controls" }, 500);
    return json({ success: true, plans, controls });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 4096);
  } catch (error) {
    const parsed = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: parsed.message }, parsed.status);
  }

  const network = String(body.network || "").toLowerCase();
  const scopeType = String(body.scope_type || "");
  const scopeValue = String(body.scope_value || "").trim().slice(0, 160);
  const enabled = body.enabled === true;
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!NETWORKS.includes(network) || !SCOPES.includes(scopeType) || !scopeValue) {
    return json({ error: "Invalid availability target" }, 400);
  }
  if (scopeType === "network" && scopeValue !== "*") return json({ error: "Invalid network target" }, 400);
  if (!enabled && reason.length < 3) return json({ error: "A reason is required to disable a plan" }, 400);

  if (scopeType !== "network") {
    let targetQuery = db.from("vtunaija_data_catalog").select("id").eq("network", network);
    targetQuery = scopeType === "family" ? targetQuery.eq("family_key", scopeValue) : targetQuery.eq("id", scopeValue);
    const { data: target, error: targetError } = await targetQuery.limit(1).maybeSingle();
    if (targetError) return json({ error: "Could not verify the selected availability target" }, 500);
    if (!target) return json({ error: "The selected family or plan no longer exists" }, 400);
  }

  const { error } = await db.rpc("set_vtu_plan_control", {
    p_admin_user_id: admin.userId,
    p_provider: "vtunaija",
    p_network: network,
    p_scope_type: scopeType,
    p_scope_value: scopeValue,
    p_enabled: enabled,
    p_reason: reason,
  });
  if (error) return json({ error: "Could not update availability" }, 500);
  const { data: control, error: readError } = await db.from("vtu_plan_controls")
    .select("provider, network, scope_type, scope_value, enabled, reason, source, updated_at")
    .eq("provider", "vtunaija")
    .eq("network", network)
    .eq("scope_type", scopeType)
    .eq("scope_value", scopeValue)
    .single();
  if (readError) return json({ error: "Availability changed, but its latest status could not be loaded" }, 500);
  return json({ success: true, control });
});
