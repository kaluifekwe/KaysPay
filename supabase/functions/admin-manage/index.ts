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

const VALID_ROLES = ["support", "super_admin"];

// super_admin only, for every action here (list included â€?who's on the
// admin team is itself sensitive).
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  let admin;
  try {
    admin = await requireAdmin(req, "super_admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const db = adminClient();

  if (req.method === "GET") {
    const { data, error } = await db
      .from("admin_users")
      .select("user_id, role, invited_by, disabled_at, created_at")
      .order("created_at");
    if (error) return json({ error: "Could not load admins" }, 500);

    // Emails aren't in admin_users (it only references auth.users(id)) â€?    // resolve them for display via the same admin API used elsewhere.
    const withEmail = await Promise.all(
      (data || []).map(async (row) => {
        const { data: u } = await db.auth.admin.getUserById(row.user_id);
        return { ...row, email: u?.user?.email ?? null };
      }),
    );
    return json({ success: true, admins: withEmail });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 1024);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const action = String(body.action || "");
  const targetUserId = String(body.user_id || "");
  if (!targetUserId) return json({ error: "user_id required" }, 400);

  const { data: activeSuperAdminsRaw } = await db.rpc("count_active_super_admins");
  const activeSuperAdmins = Number(activeSuperAdminsRaw ?? 0);

  const { data: target } = await db
    .from("admin_users")
    .select("role, disabled_at")
    .eq("user_id", targetUserId)
    .maybeSingle();
  if (!target) return json({ error: "Admin not found" }, 404);

  const targetIsActiveSuperAdmin = target.role === "super_admin" && !target.disabled_at;

  if (action === "disable") {
    if (targetIsActiveSuperAdmin && activeSuperAdmins <= 1) {
      return json({ error: "Cannot disable the last remaining super admin" }, 400);
    }
    const { error } = await db
      .from("admin_users")
      .update({ disabled_at: new Date().toISOString() })
      .eq("user_id", targetUserId);
    if (error) return json({ error: "Could not disable admin" }, 500);
    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "admin_disabled",
      target_type: "admin_users",
      target_id: targetUserId,
    });
    return json({ success: true });
  }

  if (action === "enable") {
    const { error } = await db
      .from("admin_users")
      .update({ disabled_at: null })
      .eq("user_id", targetUserId);
    if (error) return json({ error: "Could not enable admin" }, 500);
    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "admin_enabled",
      target_type: "admin_users",
      target_id: targetUserId,
    });
    return json({ success: true });
  }

  if (action === "set_role") {
    const newRole = String(body.role || "");
    if (!VALID_ROLES.includes(newRole)) return json({ error: "Invalid role" }, 400);
    if (targetIsActiveSuperAdmin && newRole !== "super_admin" && activeSuperAdmins <= 1) {
      return json({ error: "Cannot demote the last remaining super admin" }, 400);
    }
    const { error } = await db
      .from("admin_users")
      .update({ role: newRole })
      .eq("user_id", targetUserId);
    if (error) return json({ error: "Could not change role" }, 500);
    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "admin_role_changed",
      target_type: "admin_users",
      target_id: targetUserId,
      metadata: { new_role: newRole },
    });
    return json({ success: true });
  }

  return json({ error: "Invalid action" }, 400);
});
