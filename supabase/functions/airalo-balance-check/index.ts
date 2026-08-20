import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret } from "../_shared/auth.ts";
import { getAiraloBalance, isAiraloConfigured } from "../_shared/airalo-client.ts";
import { sendEmail, isResendConfigured } from "../_shared/resend-client.ts";

// Low-credit alert for the Airalo POSTPAID reseller account (see migration
// 048 for the schedule). Airalo bills postpaid up to a $10,000 credit limit;
// when the available balance runs out, new eSIM orders fail. This sweeps the
// balance and emails the owner while it's below the threshold, so there's time
// to pay Airalo down before customers hit failures.
//
// Cron-only: gated by the shared x-cron-secret (same as the reconcile sweeps).
const THRESHOLD_USD = 2000; // alert while less than this remains of the credit line
const ALERT_EMAIL = "kaluifekwe6@gmail.com"; // owner's address (their own, not sensitive)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  if (!isAiraloConfigured()) return json({ checked: false, reason: "airalo not configured" });

  const supabase = adminClient();

  let balance: { available: number; currency: string } | null;
  try {
    balance = await getAiraloBalance(supabase);
  } catch (e) {
    return json({ checked: false, reason: "balance fetch failed", message: String((e as Error)?.message ?? e) });
  }
  if (!balance) return json({ checked: false, reason: "no balance returned" });

  if (balance.available >= THRESHOLD_USD) {
    return json({ checked: true, available: balance.available, alerted: false });
  }

  if (!isResendConfigured()) {
    return json({ checked: true, available: balance.available, alerted: false, reason: "resend not configured" });
  }

  const html =
    `<p>Your Airalo postpaid credit is running low.</p>` +
    `<p><b>Available: $${balance.available.toFixed(2)} ${balance.currency}</b> (alert threshold $${THRESHOLD_USD}).</p>` +
    `<p>Airalo bills postpaid up to a $10,000 credit limit — once the available balance reaches $0, new eSIM ` +
    `orders will start failing. Pay down your Airalo balance to keep eSIM sales flowing.</p>`;

  const r = await sendEmail(ALERT_EMAIL, "KaysPay — Airalo credit running low", html);
  return json({ checked: true, available: balance.available, alerted: r.ok, emailError: r.error ?? null });
});
