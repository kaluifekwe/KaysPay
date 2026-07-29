import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { verifyCronSecret } from "../_shared/auth.ts";
import { getBalance, isSmspvaConfigured } from "../_shared/smspva-client.ts";
import { sendEmail, isResendConfigured } from "../_shared/resend-client.ts";

// Low-balance alert for the SMSPVA PREPAID account (see migration 054 for the
// schedule). SMSPVA is pay-as-you-go — when the balance runs out, foreign-
// number purchases start failing (and auto-refunding). This sweeps the balance
// and emails the owner while it's below the threshold, so there's time to top
// up before customers hit failures. Cron-only: gated by the x-cron-secret.
const THRESHOLD_USD = 5; // alert while less than this remains
const ALERT_EMAIL = "kaluifekwe6@gmail.com"; // owner's own address

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  if (!isSmspvaConfigured()) return json({ checked: false, reason: "smspva not configured" });

  let balance: number | null;
  try {
    balance = await getBalance();
  } catch (e) {
    return json({ checked: false, reason: "balance fetch failed", message: String((e as Error)?.message ?? e) });
  }
  if (balance === null) return json({ checked: false, reason: "no balance returned" });

  if (balance >= THRESHOLD_USD) {
    return json({ checked: true, balance, alerted: false });
  }

  if (!isResendConfigured()) {
    return json({ checked: true, balance, alerted: false, reason: "resend not configured" });
  }

  const html =
    `<p>Your SMSPVA balance is running low.</p>` +
    `<p><b>Balance: $${balance.toFixed(2)}</b> (alert threshold $${THRESHOLD_USD}).</p>` +
    `<p>SMSPVA powers the Foreign Number feature. Once it hits $0, new number purchases fail ` +
    `(and customers are auto-refunded). Top up at smspva.com to keep the feature working.</p>`;

  const r = await sendEmail(ALERT_EMAIL, "Kay's Pay — SMSPVA balance running low", html);
  return json({ checked: true, balance, alerted: r.ok, emailError: r.error ?? null });
});
