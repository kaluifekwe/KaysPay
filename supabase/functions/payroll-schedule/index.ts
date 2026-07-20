import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";
import { DATA_BUNDLES, VALID_NETWORKS } from "../_shared/vtu-catalog.ts";
import { Features, SERVICE_DISABLED_MESSAGE } from "../_shared/features.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Creates a payroll mandate (one-time / weekly / monthly). NO debit here —
// recurring payrolls charge the wallet at EACH run (payroll-execute). Requires
// PIN/biometric step-up, which authorizes the recurring mandate.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Payroll switched off 2026-07-18 — no new mandates may be created.
  // Flip Features.PAYROLL_ENABLED to restore (and re-schedule the cron,
  // see migration 044). payroll-cancel stays open deliberately.
  if (!Features.PAYROLL_ENABLED) {
    return json({ success: false, error: SERVICE_DISABLED_MESSAGE }, 503);
  }

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const serviceType = body?.service_type === "data" ? "data" : "airtime";
  const frequency = ["once", "weekly", "monthly"].includes(body?.frequency) ? body.frequency : "once";
  const firstRun = new Date(String(body?.scheduled_for || ""));
  const rawRecipients: any[] = Array.isArray(body?.recipients) ? body.recipients : [];

  if (isNaN(firstRun.getTime()) || firstRun.getTime() <= Date.now()) {
    return json({ success: false, error: "Choose a future date and time." }, 400);
  }
  if (rawRecipients.length === 0) {
    return json({ success: false, error: "Add at least one recipient." }, 400);
  }

  // Re-derive every recipient's value server-side — never trust client amounts.
  const recipients: any[] = [];
  let total = 0;
  for (const r of rawRecipients) {
    const phone = String(r?.phone || "");
    const network = String(r?.network || "").toLowerCase();
    if (!/^0\d{10}$/.test(phone)) return json({ success: false, error: `Invalid number: ${phone}` }, 400);
    if (!VALID_NETWORKS.includes(network)) return json({ success: false, error: `Invalid network for ${phone}` }, 400);

    if (serviceType === "airtime") {
      const amountKobo = Math.round(Number(r?.amount_kobo));
      if (!Number.isInteger(amountKobo) || amountKobo < 5000 || amountKobo > 5000000) {
        return json({ success: false, error: `Invalid amount for ${phone}` }, 400);
      }
      recipients.push({ phone, network, amount_kobo: amountKobo });
      total += amountKobo;
    } else {
      const bundle = DATA_BUNDLES[String(r?.bundle_id || "")];
      if (!bundle || bundle.network !== network) {
        return json({ success: false, error: `Invalid data plan for ${phone}` }, 400);
      }
      recipients.push({ phone, network, bundle_id: r.bundle_id, amount_kobo: bundle.amount });
      total += bundle.amount;
    }
  }

  const supabase = adminClient();

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) return json({ success: false, error: "Re-authorization required. Please try again." }, 401);

  const { data: payrollId, error } = await supabase.rpc("create_payroll", {
    p_user_id: user.id,
    p_service_type: serviceType,
    p_recipients: recipients,
    p_total: total,
    p_frequency: frequency,
    p_first_run: firstRun.toISOString(),
    p_idempotency_key: body.idempotency_key || null,
  });

  if (error) {
    const msg = error.message || "";
    if (msg.includes("INVALID_SCHEDULE_TIME")) return json({ success: false, error: "Choose a future date and time." }, 400);
    return json({ success: false, error: "Could not schedule payroll." }, 500);
  }

  return json({ success: true, payroll_id: payrollId, total, frequency, scheduled_for: firstRun.toISOString() });
});
