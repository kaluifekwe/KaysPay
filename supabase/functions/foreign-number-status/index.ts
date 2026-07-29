import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { getSms, isSmspvaConfigured } from "../_shared/smspva-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// A rented SMSPVA number lives ~15 min. Past that, no code will ever arrive.
const LIFESPAN_MS = 16 * 60 * 1000;

// Polls for the incoming SMS code. No money moves on a successful code (the
// purchase already completed on rental); a refund only happens when the number
// expires with no code (SMSPVA charged us nothing in that case).
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isSmspvaConfigured()) return json({ error: "Foreign Number provider not configured" }, 500);

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

  // Verify this activation belongs to the caller before querying it — never
  // trust a client-supplied id alone. Pull the metadata too (SMSPVA's get_sms
  // needs the service + country, not just the id).
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, metadata, created_at")
    .eq("user_id", user.id)
    .eq("type", "foreign_number")
    .eq("vtu_order_id", activationId)
    .maybeSingle();

  if (!tx) return json({ success: false, error: "Activation not found" }, 404);

  const service = String((tx.metadata as any)?.service || "");
  const country = String((tx.metadata as any)?.country || "");

  try {
    const result = await getSms(service, country, activationId);

    if (result.status === "STATUS_OK" && result.code) {
      // Mark the code as received so the reconcile sweep never refunds a tx
      // whose OTP already arrived (and that SMSPVA therefore charged us for).
      await supabase
        .from("transactions")
        .update({ metadata: { ...(tx.metadata as any), code_received: true, code: result.code } })
        .eq("id", tx.id);
      return json({ success: true, done: true, code: result.code });
    }

    // No code yet. If the number is past its ~15-min life, it will never
    // arrive — auto-refund now (idempotent RPC; SMSPVA charged us nothing).
    const ageMs = Date.now() - new Date(tx.created_at as string).getTime();
    if (ageMs > LIFESPAN_MS) {
      await supabase
        .rpc("refund_completed_service_transaction", { p_tx_id: tx.id, p_reason: "expired_no_code" })
        .catch(() => {});
      return json({ success: true, done: true, cancelled: true, refunded: true });
    }

    return json({ success: true, done: false });
  } catch {
    return json({ success: false, error: "Could not check status. Please try again." });
  }
});
