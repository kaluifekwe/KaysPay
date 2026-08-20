import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { cancel as smspvaCancel, getSms, isSmspvaConfigured } from "../_shared/smspva-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Cancels a rented number that never received its code and refunds the user.
// With SMSPVA the refund is ALWAYS full and safe: SMSPVA only charges us when
// a code actually arrives, so a no-code number cost us nothing to release.
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

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, status, metadata")
    .eq("user_id", user.id)
    .eq("type", "foreign_number")
    .eq("vtu_order_id", activationId)
    .maybeSingle();

  if (!tx) return json({ success: false, error: "Activation not found" }, 404);
  if (tx.status !== "completed") {
    return json({ success: true, refunded: tx.status === "failed" || tx.status === "refunded", message: "This purchase was already settled." });
  }

  // Found by the 2026-08-20 Strix pentest (vuln-0005): this endpoint only
  // checked status='completed', never whether an OTP had already arrived —
  // foreign-number-reconcile already treats code_received as "SMSPVA
  // charged us, do not refund", so a user could grab the code then call
  // this endpoint directly to claim the refund back anyway. Reject on the
  // locally-stored flag first, then re-check the provider directly in case
  // a code arrived since the last status poll and was never persisted.
  const meta = (tx.metadata as any) || {};
  if (meta.code_received || meta.code) {
    return json({ success: false, error: "This purchase already received a code and cannot be refunded." }, 409);
  }

  const service = String(meta.service || "");
  const country = String(meta.country || "");

  try {
    const latest = await getSms(service, country, activationId);
    if (latest.status === "STATUS_OK" && latest.code) {
      await supabase
        .from("transactions")
        .update({ metadata: { ...meta, code_received: true, code: latest.code } })
        .eq("id", tx.id);
      return json({ success: false, error: "This purchase already received a code and cannot be refunded." }, 409);
    }

    // Release the number on SMSPVA's side (best-effort), then refund.
    await smspvaCancel(service, country, activationId).catch(() => {});
    await confirmServiceRefund(supabase, tx.id, "user_cancelled_no_code", "automatic", true);
    return json({ success: true, refunded: true, message: "Cancelled and refunded." });
  } catch {
    return json({ success: false, error: "Could not process cancellation. Please try again." });
  }
});
