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
//
// Quidax's own docs never actually enumerate every terminal status this
// endpoint can return (see requeryOnRamp's comment) — "abandoned" was found
// by checking a real stuck order directly against Quidax's dashboard
// (2026-08-21), not from documentation. Only statuses actually confirmed
// this way belong here: guessing at unconfirmed ones risks closing out an
// order that's genuinely still in progress, which is worse than leaving a
// truly-dead one stuck as "pending" a while longer.
const TERMINAL_FAILURE_STATUSES = new Set(["failed", "needs_attention", "abandoned"]);
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
      if (!merchantReference) { skipped++; continue; }

      // Quidax's docs never actually settled which identifier this endpoint
      // wants — try their own reference first (metadata.quidax_reference,
      // e.g. "TRX-...") when we have one, then fall back to ours. A 404 on
      // the first is exactly what "wrong identifier" looks like, so it's
      // safe to just try the other rather than guess once and give up.
      const candidates = Array.from(new Set(
        [String(meta.quidax_reference || ""), merchantReference].filter(Boolean),
      ));
      if (candidates.length === 0) { skipped++; continue; }

      let remote: Awaited<ReturnType<typeof requeryOnRamp>> | null = null;
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          remote = await requeryOnRamp(candidate);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          const is404 = e instanceof QuidaxRampError && e.status === 404;
          if (!is404) break; // a non-404 failure won't be fixed by trying the other reference
        }
      }

      if (!remote) {
        if (lastError instanceof QuidaxRampError) {
          console.error(`crypto-buy-reconcile: requery failed for ${merchantReference} (status ${lastError.status}):`, lastError.message);
        }
        skipped++;
        continue;
      }

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
      } else if (TERMINAL_FAILURE_STATUSES.has(remote.status)) {
        await supabase.rpc("fail_crypto_buy", {
          p_merchant_reference: merchantReference,
          p_reason: remote.errorMessage || `reconcile_${remote.status}`,
        });
        failed++;
      } else {
        stillPending++;
      }
    }

    return { checked: stuck?.length ?? 0, completed, failed, stillPending, skipped };
  });

  return json(result);
});
