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

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const VALID_ROLES = ["support", "super_admin"];

// super_admin only. Uses Supabase's own hosted invite flow (magic link +
// set-password) rather than a custom email template â€?no new sending
// infrastructure needed.
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let admin;
  try {
    admin = await requireAdmin(req, "super_admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 1024);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const email = String(body.email || "").trim().toLowerCase();
  const role = String(body.role || "");

  if (!EMAIL_RE.test(email) || email.length > 254) {
    return json({ error: "Invalid email address" }, 400);
  }
  if (!VALID_ROLES.includes(role)) {
    return json({ error: "Invalid role" }, 400);
  }

  const db = adminClient();
  const { data: invited, error: inviteError } = await db.auth.admin.inviteUserByEmail(email);

  let targetUserId: string;
  let alreadyHadAccount = false;

  if (inviteError || !invited?.user) {
    // Most likely cause: this email already has a KaysPay account, so
    // inviteUserByEmail (which only creates brand-new accounts) refuses.
    // Fall back to granting that existing account admin access directly â€?    // they already have a password, no invite email needed.
    const { data: existingId, error: lookupError } = await db.rpc(
      "admin_lookup_user_id_by_email",
      { p_email: email },
    );
    if (lookupError || !existingId) {
      return json({ error: inviteError?.message || "Could not send invite" }, 500);
    }
    targetUserId = existingId as string;
    alreadyHadAccount = true;
  } else {
    targetUserId = invited.user.id;
  }

  const { error: insertError } = await db.from("admin_users").insert({
    user_id: targetUserId,
    role,
    invited_by: admin.userId,
  });
  if (insertError) {
    return json({ error: "This person already has admin access, or the invite could not be completed." }, 500);
  }

  await db.from("admin_actions").insert({
    admin_user_id: admin.userId,
    action_type: "admin_invited",
    target_type: "admin_users",
    target_id: targetUserId,
    metadata: { email, role, already_had_account: alreadyHadAccount },
  });

  return json({ success: true, already_had_account: alreadyHadAccount });
});
