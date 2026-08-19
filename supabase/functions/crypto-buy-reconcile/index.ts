import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { isQuidaxRampConfigured, QuidaxRampError, requeryOnRamp } from "../_shared/quidax-ramp-client.ts";
import { settleCryptoBuySuccess } from "../_shared/crypto-buy-settle.ts";

// Safety net for a buy_transaction.* webhook that never arrives — every
// other money flow in this app has a reconcile sweep (foreign-number,
// funding, nin, vtu*), Buy did not.
//
// A purchase only reaches Quidax's side once the customer transfers their
// exact amount_expected, which can take a while (a slow bank, an unwatched
// app). Sweeping too eagerly would requery orders that are legitimately
// still waiting on that transfer, so the floor below is generous.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxRampConfigured()) {
    return json({ checked: 0, reason: "Quidax Ramp not configured" });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "crypto-buy-reconcile", async () => {
    const floor = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: stuck, error } = await supabase
      .from("transactions")
      .select("id, metadata")
      .eq("status", "pending")
      .eq("type", "crypto_buy")
      .lte("created_at", floor)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) return { checked: 0, error: error.message };

    let completed = 0, failed = 0, stillPending = 0, skipped = 0;

    for (const tx of stuck || []) {
      const meta = (tx.metadata as any) || {};
      // A purchase already flagged for a refund is being handled by the
      // customer submitting bank details, not by requerying its status.
      if (meta.needs_refund_bank_details) { skipped++; continue; }

      const merchantReference = String(meta.quidax_merchant_reference || "");
      const quidaxReference = String(meta.quidax_reference || merchantReference);
      if (!merchantReference || !quidaxReference) { skipped++; continue; }

      try {
        const remote = await requeryOnRamp(quidaxReference);
        if (remote.status === "completed") {
          const received = remote.cryptoAmount;
          if (received == null || received <= 0) { skipped++; continue; }
          await settleCryptoBuySuccess(supabase, {
            merchantReference,
            receivedUsdt: received,
            txHash: remote.txHash,
            logPrefix: "crypto-buy-reconcile",
          });
          completed++;
        } else if (remote.status === "failed" || remote.status === "needs_attention") {
          await supabase.rpc("fail_crypto_buy", {
            p_merchant_reference: merchantReference,
            p_reason: remote.errorMessage || "reconcile_failed",
          });
          failed++;
        } else {
          stillPending++;
        }
      } catch (e) {
        // A 404 here most likely means quidaxReference wasn't the identifier
        // this endpoint expects (see requeryOnRamp's doc comment) — logged
        // for visibility rather than failing the sweep over one row.
        if (e instanceof QuidaxRampError) {
          console.error(`crypto-buy-reconcile: requery failed for ${merchantReference} (status ${e.status}):`, e.message);
        }
        skipped++;
      }
    }

    return { checked: stuck?.length ?? 0, completed, failed, stillPending, skipped };
  });

  return json(result);
});
