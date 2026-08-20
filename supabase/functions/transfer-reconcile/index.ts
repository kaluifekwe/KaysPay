import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { getTransfer, isFlutterwaveConfigured } from "../_shared/flutterwave-client.ts";
import { isPaystackConfigured, verifyPaystackTransfer } from "../_shared/paystack-client.ts";

// Safety net for a transfer.disburse/.reversal (Flutterwave) or
// transfer.success/.failed/.reversed (Paystack) webhook that never arrives
// — the same gap crypto-buy-reconcile and crypto-sell-reconcile close for
// their own flows. Sweeps 'transfer' transactions stuck 'pending', requeries
// whichever provider actually handled the send (metadata.actual_provider if
// the Paystack fallback fired, else metadata.provider — 'flutterwave' is the
// default primary rail), and settles or refunds directly from the real
// provider-side status.
//
// A 10-minute floor, not Sell's 5-minute one: unlike Sell's synchronous
// swap, a bank payout genuinely takes the provider some real processing
// time, so sweeping too early would just find "still pending" for
// transfers that are proceeding completely normally.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);

  const supabase = adminClient();

  const result = await withJobLock(supabase, "transfer-reconcile", async () => {
    const floor = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: stuck, error } = await supabase
      .from("transactions")
      .select("id, status, metadata")
      .eq("status", "pending")
      .eq("type", "transfer")
      .lte("created_at", floor)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) return { checked: 0, error: error.message };

    let completed = 0, failed = 0, stillPending = 0, skipped = 0;

    for (const tx of stuck || []) {
      const meta = (tx.metadata as any) || {};
      const reference = String(meta.idempotency_key || "");
      const provider = String(meta.actual_provider || meta.provider || "flutterwave");
      if (!reference) { skipped++; continue; }

      try {
        if (provider === "paystack") {
          if (!isPaystackConfigured()) { skipped++; continue; }
          const res = await verifyPaystackTransfer(reference);
          const pstatus = String(res.data?.data?.status || "");
          if (res.status >= 400 || res.data?.status !== true) { skipped++; continue; }
          if (pstatus === "success") {
            const transferCode = res.data?.data?.transfer_code ? String(res.data.data.transfer_code) : null;
            const { error: settleError } = await supabase.rpc("complete_service_transaction", { p_tx_id: tx.id, p_order_id: transferCode });
            if (settleError) { console.error(`transfer-reconcile: complete_service_transaction failed for ${tx.id}:`, settleError.message); skipped++; continue; }
            completed++;
          } else if (pstatus === "failed" || pstatus === "reversed") {
            await confirmServiceRefund(supabase, tx.id, `paystack_reconcile_${pstatus}`, "reconcile");
            failed++;
          } else {
            stillPending++;
          }
        } else {
          if (!isFlutterwaveConfigured()) { skipped++; continue; }
          const transferId = String(meta.flutterwave_transfer_id || "");
          if (!transferId) { skipped++; continue; }
          const res = await getTransfer(supabase, transferId);
          const fstatus = String(res.data?.data?.status || "");
          if (res.status >= 400 || res.data?.status !== "success") { skipped++; continue; }
          if (fstatus === "SUCCESSFUL") {
            const { error: settleError } = await supabase.rpc("complete_service_transaction", { p_tx_id: tx.id, p_order_id: transferId });
            if (settleError) { console.error(`transfer-reconcile: complete_service_transaction failed for ${tx.id}:`, settleError.message); skipped++; continue; }
            completed++;
          } else if (fstatus === "FAILED" || fstatus === "CANCELLED") {
            await confirmServiceRefund(supabase, tx.id, `flutterwave_reconcile_${fstatus}`, "reconcile");
            failed++;
          } else {
            stillPending++;
          }
        }
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        console.error(`transfer-reconcile: requery failed for tx ${tx.id} (provider ${provider}):`, detail);
        skipped++;
      }
    }

    return { checked: stuck?.length ?? 0, completed, failed, stillPending, skipped };
  });

  return json(result);
});
