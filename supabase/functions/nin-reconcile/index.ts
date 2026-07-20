import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { checkNinModificationStatus, isNinBvnConfigured } from "../_shared/ninbvn-client.ts";

// Scheduled sweep (see migration 027) resolving 'pending' orders from ANY
// of CheckMyNINBVN's four /nin-modification service types (validation, name/
// phone/address modification) — all reviewed orders (24-48h), not live API
// responses, so their submit functions leave the transaction pending and
// this polls /api/nin-modification-status until each resolves.
//
// NOTE: the exact status-field values this endpoint returns haven't been
// confirmed against a real order yet (no API key at build time) — the
// terminal-status matching below is a best guess from the docs and should
// be verified against a real pending->resolved order once available.

const RECONCILED_TYPES = ["nin_validation", "nin_name_modification", "nin_phone_modification", "nin_address_modification"];
const SUCCESS_STATUSES = ["approved", "completed", "success", "validated"];
const FAILURE_STATUSES = ["rejected", "failed", "declined"];

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!isNinBvnConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "NIN validation provider not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "nin-reconcile", async () => {
    // Orders take 24-48h; give up polling (leave for manual review) after 7
    // days rather than checking forever.
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: pending, error } = await supabase
      .from("transactions")
      .select("id, metadata")
      .eq("status", "pending")
      .in("type", RECONCILED_TYPES)
      .not("metadata->>reference_id", "is", null)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) {
      return { checked: 0, error: error.message };
    }

    let completed = 0;
    let refunded = 0;
    let stillPending = 0;

    for (const tx of pending || []) {
      const referenceId = tx.metadata?.reference_id;
      if (!referenceId) continue;

      try {
        const { data } = await checkNinModificationStatus(referenceId);
        const status = String(data?.status ?? data?.data?.status ?? "").toLowerCase();

        if (SUCCESS_STATUSES.includes(status)) {
          await supabase.rpc("complete_service_transaction", { p_tx_id: tx.id, p_order_id: referenceId });
          completed++;
        } else if (FAILURE_STATUSES.includes(status)) {
          await supabase.rpc("refund_service_transaction", { p_tx_id: tx.id, p_reason: status || "validation_rejected" });
          refunded++;
        } else {
          stillPending++;
        }
      } catch {
        stillPending++; // network hiccup this round — next sweep retries
      }
    }

    return { checked: pending?.length ?? 0, completed, refunded, stillPending };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
