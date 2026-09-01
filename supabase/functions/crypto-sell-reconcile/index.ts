import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { isQuidaxRampConfigured, QuidaxRampError, requeryOffRamp } from "../_shared/quidax-ramp-client.ts";

// Safety net for a sell_transaction.successful/.failed webhook that never
// arrives — Sell now pays the customer's bank directly via Quidax's Ramp
// off-ramp (migration 139), not the old internal Exchange swap this
// function originally reconciled. Same "requery, don't guess" discipline as
// crypto-buy-reconcile, including trying both the reference Quidax's own
// docs are ambiguous about (see requeryOffRamp).
//
// 10-minute floor, not the old 5-minute one: off-ramp genuinely takes
// Quidax real processing time (crypto deposit confirmation, then a real
// bank payout), unlike the old synchronous swap-confirm this replaced.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxRampConfigured()) {
    return json({ checked: 0, reason: "Quidax Ramp not configured" });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "crypto-sell-reconcile", async () => {
    const floor = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    let completed = 0, failed = 0, stillPending = 0, skipped = 0, checked = 0;

    // A single transaction's requery + settle, shared by both sweeps below.
    // Returns which bucket it landed in, or null if it couldn't be checked
    // at all (no reference on record, or Quidax genuinely unreachable).
    const reconcileOne = async (tx: { id: string; metadata: unknown }): Promise<"completed" | "failed" | "pending" | null> => {
      const meta = (tx.metadata as any) || {};
      const merchantReference = String(meta.quidax_merchant_reference || "");
      const candidates = Array.from(new Set(
        [String(meta.quidax_reference || ""), merchantReference].filter(Boolean),
      ));
      if (candidates.length === 0) return null;

      let remote: Awaited<ReturnType<typeof requeryOffRamp>> | null = null;
      let lastError: unknown = null;
      for (const candidate of candidates) {
        try {
          remote = await requeryOffRamp(candidate);
          lastError = null;
          break;
        } catch (e) {
          lastError = e;
          const is404 = e instanceof QuidaxRampError && e.status === 404;
          if (!is404) break;
        }
      }

      if (!remote) {
        if (lastError) console.error(`crypto-sell-reconcile: requery failed for tx ${tx.id}:`, lastError instanceof Error ? lastError.message : String(lastError));
        return null;
      }

      const key = merchantReference || candidates[0];
      if (remote.status === "successful" || remote.fiatPayoutStatus === "completed") {
        if (!remote.fiatPayoutAmount || remote.fiatPayoutAmount <= 0) return null;
        const { error: settleError } = await supabase.rpc("complete_crypto_sell_offramp", {
          p_reference: key,
          p_ngn_kobo: Math.round(remote.fiatPayoutAmount * 100),
          p_markup_kobo:remote.merchantMarkup===null?null:Math.round(remote.merchantMarkup*100),
          p_processor_fee_kobo:remote.processorFee===null?null:Math.round(remote.processorFee*100),
          p_vat_kobo:remote.vat===null?null:Math.round(remote.vat*100),
        });
        if (settleError) {
          console.error(`crypto-sell-reconcile: complete_crypto_sell_offramp failed for ${key}:`, settleError.message);
          return null;
        }
        return "completed";
      } else if (remote.status === "failed" || remote.fiatPayoutStatus === "failed") {
        await supabase.rpc("fail_crypto_sell_offramp", { p_reference: key, p_reason: "reconcile_failed" });
        return "failed";
      }
      return "pending";
    };

    const { data: stuck, error } = await supabase
      .from("transactions")
      .select("id, metadata")
      .eq("status", "pending")
      .eq("type", "crypto_sell")
      .lte("created_at", floor)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) return { checked: 0, error: error.message };
    checked += stuck?.length ?? 0;

    for (const tx of stuck || []) {
      const outcome = await reconcileOne(tx);
      if (outcome === "completed") completed++;
      else if (outcome === "failed") failed++;
      else if (outcome === "pending") stillPending++;
      else skipped++;
    }

    // Self-heals a sale we'd already marked 'failed' if Quidax later
    // confirms it actually succeeded (today's real incident: an amount
    // mismatch held it for manual review, then Quidax approved it after
    // the fact) -- no admin action needed for this to catch up on its own.
    // Excludes anything an admin already resolved by hand (migration 183).
    const { data: recentlyFailedRaw, error: failedError } = await supabase
      .from("transactions")
      .select("id, metadata")
      .eq("status", "failed")
      .eq("type", "crypto_sell")
      .gte("created_at", cutoff)
      .limit(50);

    if (!failedError) {
      // Filtered here rather than in the query -- JSONB path filters via the
      // JS client are easy to get subtly wrong (a missing key vs. an
      // explicit false behave differently across `is`/`eq`/`neq`). A plain
      // JS check is unambiguous: only skip a row an admin actually resolved.
      const recentlyFailed = (recentlyFailedRaw || []).filter((tx) => (tx.metadata as any)?.resolved_manually !== true);
      checked += recentlyFailed.length;
      for (const tx of recentlyFailed) {
        const outcome = await reconcileOne(tx);
        if (outcome === "completed") completed++;
        else skipped++;
      }
    }

    return { checked, completed, failed, stillPending, skipped };
  });

  return json(result);
});
