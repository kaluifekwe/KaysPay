import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, getAuthUser } from "../_shared/auth.ts";
import { isBootstrapOperator } from "../_shared/admin-bootstrap.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// One-time setup is restricted to an explicitly allowlisted Supabase Auth
// user ID. The database RPC still serializes concurrent callers, but table
// emptiness alone is never treated as authorization.
serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!isBootstrapOperator(user.id, Deno.env.get("ADMIN_BOOTSTRAP_USER_IDS"))) {
    return json({ error: "Not authorized to complete admin setup" }, 403);
  }

  const db = adminClient();
  const { data, error } = await db.rpc("bootstrap_admin", { p_user_id: user.id });
  if (error) return json({ error: "Could not complete setup" }, 500);
  if (data !== true) return json({ error: "Admin panel is already set up" }, 403);

  return json({ success: true, role: "super_admin" });
});
