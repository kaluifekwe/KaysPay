import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, enforceRateLimit } from "../_shared/auth.ts";
import {
  isVtuNaijaConfigured,
  normalizeVTUNaijaQueryResult,
  queryVTUNaijaDataTransaction,
  queryVTUNaijaTransaction,
} from "../_shared/vtunaija-client.ts";

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

  const rate = await enforceRateLimit(supabase, "vtu_verify_order", user.id, 20, 60, user.id);
  if (!rate.allowed) {
    return json({
      error: "Please wait a moment and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

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

  // Only VTU service purchases are verifiable this way.
  if (!["airtime", "data", "bill", "exam_pin"].includes(tx.type)) return json({ status: "pending" });

  const metadata = tx.metadata as {
    provider?: string;
    idempotency_key?: string;
    provider_transaction_id?: string;
  } | null;
  const provider = metadata?.provider;
  const ref = metadata?.idempotency_key;
  if (!ref) return json({ status: "pending" });

  if (provider !== "vtunaija" || !isVtuNaijaConfigured()) return json({ status: "pending" });

  const queryId = metadata?.provider_transaction_id ?? ref;
  try {
    const result = tx.type === "data"
      ? await queryVTUNaijaDataTransaction(queryId)
      : await queryVTUNaijaTransaction(queryId);
    const normalized = normalizeVTUNaijaQueryResult(result);

    if (normalized.outcome === "success") {
      const { error: completeError } = await supabase.rpc("complete_service_transaction", {
        p_tx_id: tx.id,
        p_order_id: normalized.transactionId,
      });
      return json({ status: completeError ? "pending" : "completed" });
    }

    // Foreground polling never returns money. The scheduled VTUnaija
    // reconciler owns refunds after separated provider confirmations.
    return json({ status: "pending" });
  } catch {
    return json({ status: "pending" });
  }
});
