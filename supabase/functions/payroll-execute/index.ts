import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { DATA_BUNDLES, KOBO } from "../_shared/vtu-catalog.ts";
import { callVTUAfricaWithRetry, vtuAfricaOutcome, isVtuAfricaConfigured } from "../_shared/vtuafrica-client.ts";
import { Features } from "../_shared/features.ts";

// Scheduled sweep (cron, migration 030) that runs due payrolls. Recurring
// model: each due cycle DEBITS the wallet (debit_payroll_run) then sends to
// each recipient, refunding any that fail, and advances next_run by the
// payroll's frequency. Insufficient funds -> skip this cycle, keep the
// payroll active for next time.

function refKey(): string {
  return `pay${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

// Recipients within ONE payroll are sent this many at a time, instead of one
// at a time. Kept deliberately bounded (rather than firing all recipients at
// once) so a large payroll can't hammer VTUAfrica with an unbounded burst of
// concurrent requests, and payrolls themselves still run one after another
// for the same reason.
const RECIPIENT_CONCURRENCY = 10;

interface RecipientOutcome {
  entry: { phone: string; status: "sent" | "failed"; reason?: string };
  refundKobo: number;
}

async function sendToRecipient(payroll: any, r: any): Promise<RecipientOutcome> {
  const phone = String(r.phone || "");
  const network = String(r.network || "");
  const valueKobo = Number(r.amount_kobo) || 0;

  try {
    let resp: any;
    if (payroll.service_type === "airtime") {
      resp = await callVTUAfricaWithRetry("/airtime", { network, phone, amount: valueKobo / KOBO, ref: refKey() });
    } else {
      const bundle = DATA_BUNDLES[String(r.bundle_id || "")];
      if (!bundle) {
        return { entry: { phone, status: "failed", reason: "invalid_bundle" }, refundKobo: valueKobo };
      }
      resp = await callVTUAfricaWithRetry("/data", {
        MobileNumber: phone,
        service: bundle.serviceCode,
        DataPlan: bundle.planCode,
        maxamount: bundle.amount / KOBO,
        ref: refKey(),
      });
    }

    if (vtuAfricaOutcome(resp) === "failed") {
      return { entry: { phone, status: "failed", reason: resp?.description?.message || "provider_rejected" }, refundKobo: valueKobo };
    }
    return { entry: { phone, status: "sent" }, refundKobo: 0 };
  } catch (e) {
    return { entry: { phone, status: "failed", reason: (e as Error).message }, refundKobo: valueKobo };
  }
}

async function sendToAllRecipients(payroll: any, recipients: any[]): Promise<{ result: any[]; refundKobo: number }> {
  const result: any[] = [];
  let refundKobo = 0;

  for (let i = 0; i < recipients.length; i += RECIPIENT_CONCURRENCY) {
    const batch = recipients.slice(i, i + RECIPIENT_CONCURRENCY);
    const outcomes = await Promise.all(batch.map((r) => sendToRecipient(payroll, r)));
    for (const outcome of outcomes) {
      result.push(outcome.entry);
      refundKobo += outcome.refundKobo;
    }
  }

  return { result, refundKobo };
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  // Payroll switched off 2026-07-18. The cron job is unscheduled (migration
  // 044), so this should never be reached — this is the belt-and-braces stop
  // in case the job is still live somewhere. 200, not 503, so a stray cron
  // invocation doesn't fill the logs with errors. No wallet is debited.
  if (!Features.PAYROLL_ENABLED) {
    return new Response(JSON.stringify({ checked: 0, reason: "payroll disabled" }), { status: 200 });
  }

  if (!isVtuAfricaConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "VTUAfrica not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const result = await withJobLock(supabase, "payroll-execute", async () => {
    const { data: due, error } = await supabase.rpc("claim_due_payrolls", { p_limit: 20 });
    if (error) {
      return { checked: 0, error: error.message };
    }

    let ran = 0;
    let skipped = 0;

    for (const payroll of (due || []) as any[]) {
      // 1. Charge the wallet for this cycle. Short balance -> skip, keep active.
      const { data: txId, error: debitErr } = await supabase.rpc("debit_payroll_run", { p_payroll_id: payroll.id });
      if (debitErr || !txId) {
        await supabase.rpc("skip_payroll_run", { p_payroll_id: payroll.id });
        skipped++;
        continue;
      }

      // 2. Send to each recipient (funds already collected) — up to
      // RECIPIENT_CONCURRENCY at a time instead of one at a time.
      const recipients: any[] = Array.isArray(payroll.recipients) ? payroll.recipients : [];
      const { result: sendResult, refundKobo } = await sendToAllRecipients(payroll, recipients);

      // 3. Settle: refund failed recipients + advance the schedule.
      await supabase.rpc("finish_payroll_run", {
        p_payroll_id: payroll.id,
        p_tx_id: txId,
        p_refund: refundKobo,
        p_result: sendResult,
      });
      ran++;
    }

    return { checked: (due || []).length, ran, skipped };
  });

  return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
});
