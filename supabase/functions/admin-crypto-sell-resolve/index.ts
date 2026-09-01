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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESOLUTIONS = new Set(["ngn_paid_by_quidax", "crypto_returned", "writeoff"]);

// Manual recovery path for a Sell that's stuck 'failed' with
// failure_reason 'offramp_failed' -- see migration 183 for the full
// picture. super_admin only: this can mark a transaction 'completed' with
// an admin-entered NGN amount based on what Quidax confirms directly, the
// same trust level as a manual refund.
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
    const { data, error } = await db.rpc("admin_list_stuck_crypto_sells");
    if (error) return json({ error: "Could not load stuck sells" }, 500);
    return json({ success: true, stuck_sells: data });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const transactionId = String(body?.transaction_id || "");
  const resolution = String(body?.resolution || "");
  const notes = String(body?.notes || "").trim();
  const settledNgnKobo = body?.settled_ngn_kobo != null ? Number(body.settled_ngn_kobo) : null;

  if (!UUID.test(transactionId)) return json({ error: "Invalid transaction id" }, 400);
  if (!RESOLUTIONS.has(resolution)) return json({ error: "Invalid resolution" }, 400);
  if (notes.length < 3 || notes.length > 500) return json({ error: "Notes must be 3 to 500 characters" }, 400);
  if (resolution === "ngn_paid_by_quidax" && (!settledNgnKobo || settledNgnKobo <= 0)) {
    return json({ error: "Enter the confirmed NGN amount Quidax paid" }, 400);
  }

  const { data, error } = await db.rpc("admin_resolve_crypto_sell_offramp", {
    p_admin_user_id: admin.userId,
    p_transaction_id: transactionId,
    p_resolution: resolution,
    p_notes: notes,
    p_settled_ngn_kobo: resolution === "ngn_paid_by_quidax" ? settledNgnKobo : null,
  });

  if (error) {
    const code = error.message || "";
    if (code.includes("TRANSACTION_NOT_FOUND")) return json({ error: "Transaction not found" }, 404);
    if (code.includes("NOT_A_CRYPTO_SELL")) return json({ error: "This isn't a crypto sell transaction" }, 400);
    if (code.includes("NOT_IN_FAILED_STATE")) return json({ error: "This transaction isn't in a failed state — it may already be resolved" }, 409);
    return json({ error: "Could not resolve this transaction" }, 500);
  }

  await db.from("admin_actions").insert({
    admin_user_id: admin.userId,
    action_type: "crypto_sell_offramp_resolved",
    target_type: "transactions",
    target_id: transactionId,
    reason: notes,
    metadata: { resolution, settled_ngn_kobo: settledNgnKobo },
  });

  return json({ success: true, result: data });
});
