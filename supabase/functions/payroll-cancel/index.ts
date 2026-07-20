import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Cancels a recurring/scheduled payroll so it stops running. Owner-scoped —
// cancel_payroll only matches the caller's own payroll id. No money moves
// (future cycles simply won't be charged).
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

  const payrollId = String(body?.payroll_id || "");
  if (!payrollId) return json({ success: false, error: "Missing payroll id" }, 400);

  const supabase = adminClient();
  const { data: cancelled, error } = await supabase.rpc("cancel_payroll", {
    p_user_id: user.id,
    p_payroll_id: payrollId,
  });

  if (error) return json({ success: false, error: "Could not cancel payroll." }, 500);
  if (!cancelled) return json({ success: false, error: "Payroll not found or already inactive." }, 404);
  return json({ success: true });
});
