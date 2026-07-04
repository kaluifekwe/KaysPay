import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { getStatus, setStatus, isGrizzlySMSConfigured } from "../_shared/grizzlysms-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Polls for the incoming SMS code. No money moves here — the purchase
// already completed when the number was rented; this just checks whether
// the code has arrived yet.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isGrizzlySMSConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const activationId = String(body?.activation_id || "");
  if (!activationId) return json({ success: false, error: "Missing activation_id" }, 400);

  const supabase = adminClient();

  // Verify this activation actually belongs to the caller before ever
  // querying it on their behalf — never trust a client-supplied id alone.
  const { data: tx } = await supabase
    .from("transactions")
    .select("id")
    .eq("user_id", user.id)
    .eq("type", "foreign_number")
    .eq("vtu_order_id", activationId)
    .maybeSingle();

  if (!tx) return json({ success: false, error: "Activation not found" }, 404);

  try {
    const result = await getStatus(activationId);

    if (result.status === "STATUS_OK" && result.code) {
      // Finalize on GrizzlySMS's side now that the code has been delivered.
      await setStatus(activationId, 6).catch(() => {});
      return json({ success: true, done: true, code: result.code });
    }

    if (result.status === "STATUS_CANCEL") {
      return json({ success: true, done: true, cancelled: true });
    }

    return json({ success: true, done: false });
  } catch {
    return json({ success: false, error: "Could not check status. Please try again." });
  }
});
