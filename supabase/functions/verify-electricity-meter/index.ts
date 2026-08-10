import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { ELECTRICITY_PROVIDERS, resolveVtunaijaDiscoId } from "../_shared/vtu-catalog.ts";
import {
  isVtuNaijaConfigured,
  normalizeElectricityMeterVerification,
  verifyElectricityMeter,
} from "../_shared/vtunaija-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Read-only pre-payment check: confirms a meter number resolves to a real
// customer BEFORE any money moves, so a typo'd meter is caught before
// payment rather than after (see ElectricityPayScreen.tsx). Never debits,
// never touches transactions/wallet — a plain lookup against VTUnaija's own
// /billpayment/verify/ endpoint, gated behind the same DISCO resolution
// vtu-purchase's electricity case uses (resolveVtunaijaDiscoId), so a meter
// verified here always resolves to the identical disco_name code at
// purchase time.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isVtuNaijaConfigured()) {
    return json({ success: false, error: "Meter verification isn't available right now." }, 503);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  const providerId = String(body.provider_id || "");
  const meterNumber = String(body.meter_number || "").trim();
  if (!ELECTRICITY_PROVIDERS.includes(providerId)) {
    return json({ success: false, error: "Unknown electricity provider" }, 400);
  }
  if (!/^\d{6,20}$/.test(meterNumber)) {
    return json({ success: false, error: "Enter a valid meter number" }, 400);
  }

  const supabase = adminClient();
  const discoId = await resolveVtunaijaDiscoId(supabase, providerId);
  if (!discoId) {
    return json({ success: false, error: "This provider isn't available for verification right now." }, 400);
  }

  try {
    const result = await verifyElectricityMeter(discoId, meterNumber);
    const { ok, customerName, customerAddress } = normalizeElectricityMeterVerification(result);
    if (!ok) {
      return json({
        success: false,
        error: "Could not verify this meter number. Please double-check it before proceeding.",
      });
    }
    const rawCustomerName = typeof result?.Customer_Name === "string"
      ? result.Customer_Name.trim().slice(0, 200)
      : customerName;
    const { error: saveError } = await supabase.from("saved_billing_accounts").upsert({
      user_id: user.id,
      service: "electricity",
      provider_id: providerId,
      account_number: meterNumber,
      customer_name: customerName,
      provider_customer_name: rawCustomerName,
      customer_address: customerAddress,
      last_verified_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    }, { onConflict: "user_id,service,provider_id,account_number" });
    if (saveError) console.error("Could not save verified electricity account:", saveError.code);
    return json({ success: true, customer_name: customerName, customer_address: customerAddress });
  } catch (e) {
    // Network-level failure (timeout, DNS, etc.) — ambiguous, not proof the
    // meter is wrong. Same "double-check before proceeding" message as an
    // explicit non-match, since either way we can't confirm the meter here.
    console.error("verify-electricity-meter failed:", redactSecrets(e));
    return json({
      success: false,
      error: "Could not verify this meter number right now. Please double-check it before proceeding.",
    });
  }
});
