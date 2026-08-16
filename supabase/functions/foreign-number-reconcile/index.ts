import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { getSms, isSmspvaConfigured } from "../_shared/smspva-client.ts";

// Scheduled sweep (pg_cron, migration 053) that refunds Foreign Number
// purchases whose number expired with NO code — the "user closed the app before
// the in-screen poll caught it" case. With SMSPVA, a no-code number was never
// charged to us, so refunding the user is always safe and lossless.
//
// SAFETY: a tx whose OTP already arrived is stamped `code_received` by
// foreign-number-status, so we never refund those. As a backstop we also
// re-check via get_sms — if the code is actually sitting there (arrived while
// the app was closed), we stamp it and leave the tx completed instead of
// refunding. refund_completed_service_transaction is idempotent.
serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  if (!isSmspvaConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "SMSPVA not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "foreign-number-reconcile", async () => {
    // Numbers expire ~15 min. Sweep purchases older than 15 min (past their
    // life) but younger than 48h, still 'completed' (a refund flips them to
    // 'failed'), and not already marked as having received a code.
    const floor = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();

    const { data: stuck, error } = await supabase
      .from("transactions")
      .select("id, vtu_order_id, metadata")
      .eq("status", "completed")
      .eq("type", "foreign_number")
      .not("vtu_order_id", "is", null)
      .lte("created_at", floor)
      .gte("created_at", cutoff)
      .limit(50);

    if (error) return { checked: 0, error: error.message };

    let refunded = 0;
    let hadCode = 0;
    let skipped = 0;

    for (const tx of stuck || []) {
      const meta = (tx.metadata as any) || {};
      if (meta.code_received) { skipped++; continue; } // OTP already delivered
      const activationId = String(tx.vtu_order_id || "");
      const service = String(meta.service || "");
      const country = String(meta.country || "");
      if (!activationId) continue;

      try {
        const s = await getSms(service, country, activationId);
        if (s.status === "STATUS_OK" && s.code) {
          // Code arrived while nothing was watching — stamp it, don't refund.
          await supabase
            .from("transactions")
            .update({ metadata: { ...meta, code_received: true, code: s.code } })
            .eq("id", tx.id);
          hadCode++;
        } else {
          // Expired with no code — SMSPVA charged nothing; refund the user.
          await confirmServiceRefund(supabase, tx.id, "expired_no_code_reconcile", "reconcile", true);
          refunded++;
        }
      } catch {
        skipped++; // provider hiccup — next sweep retries
      }
    }

    return { checked: stuck?.length ?? 0, refunded, hadCode, skipped };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
