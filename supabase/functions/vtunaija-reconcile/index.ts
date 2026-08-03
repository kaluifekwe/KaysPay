import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import {
  normalizeVTUNaijaResult,
  queryVTUNaijaTransaction,
  queryVTUNaijaDataTransaction,
  isVtuNaijaConfigured,
  vtunaijaOutcome,
} from "../_shared/vtunaija-client.ts";

// Scheduled sweep (see the VTUnaija migration cron) that resolves VTUnaija
// airtime/data/bill (electricity+TV) orders left 'pending' after
// vtu-purchase's inline attempt hit an ambiguous outcome (network blip /
// unrecognized response shape — VTUnaija documents no async "processing"
// state for any of these, so this should only ever catch a genuine
// network-level ambiguity, not a normal async order). Only ever transitions
// 'pending' -> 'completed'/'refunded' based on VTUnaija's own query answer —
// never guesses, and never touches a transaction whose provider isn't
// 'vtunaija'.
//
// Query-endpoint pairing assumption (NOT yet confirmed with a live forced-
// timeout test): airtime -> queryTransaction (transaction_id), data ->
// queryDataTransaction (datarequest_id) — the naming ("datarequest_id" reads
// as "any data request", not implementation-specific to one data endpoint)
// suggests this pairing holds even though our data purchases go through
// /data/, not /internetbundles/. A wrong guess here is safe, not silently
// wrong: an unrecognized/error query response is classified "unknown" and
// stays pending for the next sweep — it can never cause a false
// complete/refund. Verify this pairing with a real forced-timeout test
// before relying on it at scale.

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!isVtuNaijaConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "VTUnaija not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "vtunaija-reconcile", async () => {
    // Cap the age at 48h — anything older is treated as permanently stuck and
    // left for manual review rather than requeried forever (same convention
    // as vtu-reconcile / vtuafrica-reconcile).
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from("transactions")
      .select("id, type, metadata")
      .eq("status", "pending")
      .in("type", ["airtime", "data", "bill"])
      .eq("metadata->>provider", "vtunaija")
      .not("metadata->>idempotency_key", "is", null)
      .gte("created_at", cutoff)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) {
      return { checked: 0, error: error.message };
    }

    let completed = 0;
    let refunded = 0;
    let stillPending = 0;

    for (const tx of pending || []) {
      const requestId = tx.metadata?.idempotency_key;
      if (!requestId) continue;

      try {
        const queried = tx.type === "data"
          ? await queryVTUNaijaDataTransaction(requestId)
          : await queryVTUNaijaTransaction(requestId);
        const outcome = vtunaijaOutcome(queried);
        const normalized = normalizeVTUNaijaResult(queried);

        if (outcome === "success") {
          await supabase.rpc("complete_service_transaction", {
            p_tx_id: tx.id,
            p_order_id: normalized.id ?? normalized.ident ?? null,
          });
          completed++;
        } else if (outcome === "failed") {
          await supabase.rpc("refund_service_transaction", {
            p_tx_id: tx.id,
            p_reason: normalized.message || "reconcile_refund",
          });
          refunded++;
        } else {
          stillPending++; // unknown/malformed query response — leave it, never guess
        }
      } catch {
        stillPending++; // network hiccup this round — next sweep retries
      }
    }

    return { checked: pending?.length ?? 0, completed, refunded, stillPending };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
