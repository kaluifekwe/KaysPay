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

// Edits an active payroll's recipient list. Re-derives the per-cycle total
// server-side and requires PIN step-up (changes future recurring charges).
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  // Payroll switched off 2026-07-18 — existing mandates cannot be edited.
  // Flip Features.PAYROLL_ENABLED to restore.
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

  const payrollId = String(body?.payroll_id || "");
  const rawRecipients: any[] = Array.isArray(body?.recipients) ? body.recipients : [];
  if (!payrollId) return json({ success: false, error: "Missing payroll id" }, 400);
  if (rawRecipients.length === 0) return json({ success: false, error: "A payroll needs at least one recipient." }, 400);

  const supabase = adminClient();

  // Load the payroll to learn its service_type (drives validation), owner-scoped.
  const { data: payroll } = await supabase
    .from("scheduled_payrolls")
    .select("service_type, user_id, active, status")
    .eq("id", payrollId)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!payroll || !payroll.active || payroll.status !== "active") {
    return json({ success: false, error: "Payroll not found or not editable." }, 404);
  }

  const serviceType = payroll.service_type;
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

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) return json({ success: false, error: "Re-authorization required. Please try again." }, 401);

  const { data: ok, error } = await supabase.rpc("update_payroll", {
    p_user_id: user.id,
    p_payroll_id: payrollId,
    p_recipients: recipients,
    p_total: total,
  });

  if (error) return json({ success: false, error: "Could not update payroll." }, 500);
  if (!ok) return json({ success: false, error: "Payroll not found or not editable." }, 404);
  return json({ success: true, total });
});
