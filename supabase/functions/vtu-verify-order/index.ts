import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import {
  queryVTUAfrica,
  isVtuAfricaConfigured,
  normalizeVTUAfricaResult,
  vtuAfricaOutcome,
} from "../_shared/vtuafrica-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// On-demand settlement of a SINGLE pending VTUAfrica order, so the result
// screen can flip to Successful/Failed the moment VTUAfrica confirms — instead
// of waiting for the periodic vtuafrica-reconcile sweep. Same settle rules as
// that sweep (complete only on explicit success, refund only on explicit
// failure, otherwise leave pending), just scoped to one order the CALLER owns
// and triggered by the client's poll. It's a superset-safe of reconcile: both
// call the same idempotent complete/refund RPCs, so a race between this and the
// cron can't double-settle.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: { transaction_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const txId = String(body?.transaction_id || "");
  if (!txId) return json({ error: "Missing transaction_id" }, 400);

  const supabase = adminClient();

  // Load the order and confirm it belongs to the caller. Never trust a
  // transaction id alone — a user may only settle their OWN order.
  const { data: tx } = await supabase
    .from("transactions")
    .select("id, user_id, status, type, metadata")
    .eq("id", txId)
    .maybeSingle();

  if (!tx || tx.user_id !== user.id) return json({ error: "Not found" }, 404);

  // Already terminal — report it straight back (client stops polling).
  if (tx.status === "completed") return json({ status: "completed" });
  if (tx.status === "failed" || tx.status === "refunded") return json({ status: "failed" });
  if (tx.status !== "pending") return json({ status: tx.status });

  // Only VTUAfrica-settled service types are verifiable this way.
  if (!["airtime", "data", "bill", "exam_pin"].includes(tx.type)) return json({ status: "pending" });
  if (!isVtuAfricaConfigured()) return json({ status: "pending" });

  const ref = (tx.metadata as { idempotency_key?: string } | null)?.idempotency_key;
  if (!ref) return json({ status: "pending" });

  try {
    // Foreground verification must be bounded. The 30-second reconciler is
    // the retry mechanism; making a phone wait through exponential retries
    // only creates a second timeout without making the provider settle faster.
    const result = await queryVTUAfrica(ref, 1, 7000);
    const outcome = vtuAfricaOutcome(result);
    const normalized = normalizeVTUAfricaResult(result);

    if (outcome === "success") {
      const { error: completeError } = await supabase.rpc("complete_service_transaction", {
        p_tx_id: tx.id,
        p_order_id: normalized.reference,
      });
      if (completeError) return json({ status: "pending" });
      return json({ status: "completed" });
    }

    if (outcome === "failed") {
      // Client polling is intentionally not allowed to refund. A provider can
      // report failure briefly while telco delivery is still settling. The
      // cron reconciler requires two separated failure confirmations before
      // returning money, preventing rapid polls from creating free delivery.
      return json({ status: "pending" });
    }

    // Still processing / "Does not Exist" / unknown — leave pending, let the
    // client keep polling and the reconcile sweep remain the backstop.
    return json({ status: "pending" });
  } catch {
    // Verify endpoint hiccup — treat as not-yet-known, keep pending.
    return json({ status: "pending" });
  }
});
