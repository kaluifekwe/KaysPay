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

// Terminal statuses that mean the customer simply never transferred the
// money. These are abandoned checkouts, not failures: nothing went wrong,
// somebody just changed their mind after the payment account was issued.
// They are closed quietly and never alerted on — alerting here would bury
// the genuinely dangerous case (below) in noise about people who walked
// away. Recorded with failure_reason "not_paid" so the admin dashboard can
// label them accurately instead of showing an alarming "failed".
const UNPAID_TERMINAL_STATUSES = new Set(["abandoned", "expired", "cancelled"]);

// Past this age an order that is STILL not terminal on Quidax's side is
// not going to resolve itself. Escalated once for human eyes rather than
// left invisible, which is how eight orders accumulated unnoticed.
const STALE_ESCALATION_MS = 7 * 24 * 60 * 60 * 1000;

// Quidax defined their non-terminal states for us directly (2026-08-31),
// which is the difference between guessing at these and knowing:
//
//   "pending"     - they have NOT received value for the transaction. It is
//                   meant to transition to Abandoned after 30 minutes.
//   "processing"  - they HAVE received value; the trade is being initiated.
//   "needs_attention" - paid but stuck, and they attach a note saying why.
//
// So "processing" is a payment signal in its own right. That matters here
// because our own fiat_received_at comes from the ramp webhook, which has
// silently 401'd — an order can be genuinely paid with our record still
// blank, exactly as the 19 Aug order was.
const PAID_IN_FLIGHT_STATUSES = new Set(["processing"]);

// Quidax says they have no value for a "pending" order, so nothing is owed.
// Their own 30-minute auto-abandon has demonstrably not been firing (orders
// sat "pending" for 7-8 days), so we close these ourselves rather than wait
// for a terminal status that never comes. The window is deliberately far
// wider than their 30 minutes: a slow bank transfer that lands late would
// flip them to "processing", and closing before that would tell a customer
// who did pay that their order failed.
const UNPAID_PENDING_CLOSE_MS = 24 * 60 * 60 * 1000;

// A buy normally completes in 2-3 minutes. Money received and still not
// delivered hours later is not slow, it is stuck, and it is the one case
// worth waking someone for.
const PAID_IN_FLIGHT_ALERT_MS = 2 * 60 * 60 * 1000;
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

    // There used to be a 48-hour ceiling here as well. Anything older simply
    // stopped being checked — permanently, and with no alert — so an order
    // that got stuck just went quiet. Eight of them accumulated that way over
    // twelve days, worth over a million naira in total, and nobody knew.
    // Oldest first, so the longest-stuck orders are always cleared before
    // newer ones rather than being starved by a busy day's traffic.
    const { data: stuck, error } = await supabase
      .from("transactions")
      .select("id, created_at, metadata")
      .eq("status", "pending")
      .eq("type", "crypto_buy")
      .lte("created_at", floor)
      .order("created_at", { ascending: true })
      .limit(50);

    if (error) return { checked: 0, error: error.message };

    let completed = 0, failed = 0, notPaid = 0, stillPending = 0, escalated = 0, skipped = 0;

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
      } else if (TERMINAL_FAILURE_STATUSES.has(remote.status) || UNPAID_TERMINAL_STATUSES.has(remote.status)) {
        // Did money actually reach Quidax? Two independent signals, and
        // EITHER one saying yes is treated as yes: our own fiat_received_at
        // (set by the ramp webhook, which has silently 401'd in the past, so
        // its absence proves nothing) and Quidax's own status. Only when
        // both agree nobody paid is this closed quietly.
        const weSawPayment = !!meta.fiat_received_at;
        const quidaxSaysUnpaid = UNPAID_TERMINAL_STATUSES.has(remote.status);
        const neverPaid = quidaxSaysUnpaid && !weSawPayment;

        await supabase.rpc("fail_crypto_buy", {
          p_merchant_reference: merchantReference,
          p_reason: neverPaid ? "not_paid" : (remote.errorMessage || `reconcile_${remote.status}`),
        });

        if (neverPaid) {
          // An abandoned checkout. Nothing went wrong and no money is
          // involved, so it is closed without an alert.
          notPaid++;
        } else {
          // Money is known or suspected to have reached the provider while
          // the customer got nothing. This is the case worth waking someone
          // for, and the whole reason the noisy cases above stay silent.
          failed++;
          await supabase.rpc("record_monitoring_alert", {
            p_fingerprint: `crypto_buy_paid_undelivered_${tx.id}`,
            p_type: "crypto_buy_paid_but_undelivered",
            p_severity: "critical",
            p_details: {
              transaction_id: tx.id,
              merchant_reference: merchantReference,
              quidax_status: remote.status,
              fiat_received_at: meta.fiat_received_at ?? null,
              error_message: remote.errorMessage ?? null,
            },
          });
        }
      } else {
        const ageMs = Date.now() - new Date(tx.created_at as string).getTime();
        const paidInFlight = PAID_IN_FLIGHT_STATUSES.has(remote.status) || !!meta.fiat_received_at;

        if (paidInFlight) {
          // Money is with Quidax and the customer has nothing. Not closed —
          // the trade may still land, and failing it here would strand a paid
          // order — but escalated loudly, because this is somebody's money
          // sitting undelivered.
          stillPending++;
          if (ageMs > PAID_IN_FLIGHT_ALERT_MS) {
            escalated++;
            await supabase.rpc("record_monitoring_alert", {
              p_fingerprint: `crypto_buy_paid_inflight_${tx.id}`,
              p_type: "crypto_buy_paid_but_undelivered",
              p_severity: "critical",
              p_details: {
                transaction_id: tx.id,
                merchant_reference: merchantReference,
                quidax_status: remote.status,
                age_hours: Math.floor(ageMs / 3_600_000),
                fiat_received_at: meta.fiat_received_at ?? null,
                // Quidax attaches a note explaining a needs_attention state.
                provider_note: remote.errorMessage ?? null,
                note: "Quidax reports value received. Customer is owed delivery or a refund.",
              },
            });
          }
        } else if (ageMs > UNPAID_PENDING_CLOSE_MS) {
          // Quidax has no value for this and a full day has passed, so no
          // transfer is still in flight. Close it the same quiet way as an
          // abandoned checkout rather than leaving it pending forever.
          await supabase.rpc("fail_crypto_buy", {
            p_merchant_reference: merchantReference,
            p_reason: "not_paid",
          });
          notPaid++;
        } else {
          stillPending++;
          // Still inside the window where a slow bank transfer could arrive.
          const ageDays = Math.floor(ageMs / 86_400_000);
          if (ageMs > STALE_ESCALATION_MS) {
            escalated++;
            await supabase.rpc("record_monitoring_alert", {
              p_fingerprint: `crypto_buy_stale_${tx.id}`,
              p_type: "crypto_buy_stuck_pending",
              p_severity: "warning",
              p_details: {
                transaction_id: tx.id,
                merchant_reference: merchantReference,
                quidax_status: remote.status,
                age_days: ageDays,
                fiat_received_at: meta.fiat_received_at ?? null,
                provider_note: remote.errorMessage ?? null,
              },
            });
          }
        }
      }
    }

    return { checked: stuck?.length ?? 0, completed, failed, notPaid, stillPending, escalated, skipped };
  });

  return json(result);
});
