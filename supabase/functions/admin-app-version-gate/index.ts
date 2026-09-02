import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const VALID_PLATFORMS = ["android", "ios"];

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
      .from("app_version_gate")
      .select("platform, min_build_number, min_version, required, message, store_url, updated_at")
      .order("platform");
    if (error) return json({ error: "Could not load version gate config" }, 500);
    return json({ success: true, platforms: data });
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

    const platform = String(body.platform || "");
    const minBuildNumber = Number(body.min_build_number);
    const minVersion = String(body.min_version || "").trim().slice(0, 20);
    const required = body.required === true;
    const message = String(body.message || "").trim().slice(0, 300);
    const storeUrl = String(body.store_url || "").trim();

    if (!VALID_PLATFORMS.includes(platform)) return json({ error: "Invalid platform" }, 400);
    if (!Number.isInteger(minBuildNumber) || minBuildNumber < 1) return json({ error: "Invalid minimum build number" }, 400);
    if (!minVersion) return json({ error: "Minimum version label is required" }, 400);
    if (!/^https:\/\//.test(storeUrl)) return json({ error: "Store URL must be a valid https link" }, 400);

    const db = adminClient();
    const { error } = await db
      .from("app_version_gate")
      .update({
        min_build_number: minBuildNumber,
        min_version: minVersion,
        required,
        message: message || null,
        store_url: storeUrl,
        updated_at: new Date().toISOString(),
      })
      .eq("platform", platform);
    if (error) return json({ error: "Could not update version gate" }, 500);

    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "app_version_gate_update",
      target_type: "app_version_gate",
      target_id: platform,
      reason: null,
      metadata: { min_build_number: minBuildNumber, min_version: minVersion, required },
    });

    const { data: updated, error: readError } = await db
      .from("app_version_gate")
      .select("platform, min_build_number, min_version, required, message, store_url, updated_at")
      .eq("platform", platform)
      .single();
    if (readError) return json({ error: "Updated, but the latest config could not be loaded" }, 500);
    return json({ success: true, platform: updated });
  }

  return json({ error: "Method not allowed" }, 405);
});
