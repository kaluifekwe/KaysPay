import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    await requireAdmin(req, "support");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  const db = adminClient();
  const { data, error } = await db.rpc("admin_share_report", { p_recent_limit: 8 });
  if (error) return json({ error: "Could not load share report" }, 500);

  return json({ success: true, report: data });
});
