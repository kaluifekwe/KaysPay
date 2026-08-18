import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const VALID_SERVICES = ["vtu", "esim", "foreign_number", "identity", "nin_modification", "transfer"];

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (req.method === "GET") {
    try {
      await requireAdmin(req, "support");
    } catch (e) {
      if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
      return json({ error: "Unauthorized" }, 401);
    }
    const db = adminClient();
    const { data, error } = await db
      .from("service_controls")
      .select("service, enabled, reason, updated_at")
      .order("service");
    if (error) return json({ error: "Could not load service controls" }, 500);
    return json({ success: true, services: data });
  }

  if (req.method === "POST") {
    let admin;
    try {
      admin = await requireAdmin(req, "super_admin");
    } catch (e) {
      if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
      return json({ error: "Unauthorized" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await readJsonBody(req, 2048);
    } catch (error) {
      const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
      return json({ error: e.message }, e.status);
    }

    const service = String(body.service || "");
    const enabled = body.enabled === true;
    const reason = String(body.reason || "").trim().slice(0, 500);

    if (!VALID_SERVICES.includes(service)) {
      return json({ error: "Invalid service" }, 400);
    }
    if (!enabled && reason.length < 3) {
      return json({ error: "A reason is required to disable a service" }, 400);
    }

    const db = adminClient();
    const { error } = await db
      .from("service_controls")
      .update({ enabled, reason: reason || null, updated_at: new Date().toISOString() })
      .eq("service", service);
    if (error) return json({ error: "Could not update service control" }, 500);

    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "service_control_toggle",
      target_type: "service_controls",
      target_id: service,
      reason: reason || null,
      metadata: { enabled },
    });

    const { data: updated, error: readError } = await db
      .from("service_controls")
      .select("service, enabled, reason, updated_at")
      .eq("service", service)
      .single();
    if (readError) return json({ error: "Service changed, but its latest status could not be loaded" }, 500);
    return json({ success: true, service: updated });
  }

  return json({ error: "Method not allowed" }, 405);
});
