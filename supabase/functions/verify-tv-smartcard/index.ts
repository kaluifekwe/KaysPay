import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, readJsonBody } from "../_shared/auth.ts";
import { TVServiceProvider, VTUNAIJA_CABLE_IDS } from "../_shared/vtu-catalog.ts";
import {
  isVtuNaijaConfigured,
  normalizeCableTVSmartcardVerification,
  verifyCableTVSmartcard,
} from "../_shared/vtunaija-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

const PROVIDERS: TVServiceProvider[] = ["gotv", "dstv", "startimes"];

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
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);

  const supabase = adminClient();
  const rate = await enforceRateLimit(supabase, "verify_tv_smartcard", user.id, 10, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many verification attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  if (!isVtuNaijaConfigured()) {
    return json({ success: false, error: "Smartcard verification isn't available right now." }, 503);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req);
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  const provider = String(body.provider_id || "").toLowerCase() as TVServiceProvider;
  const smartcardNumber = String(body.smartcard_number || "").trim();
  if (!PROVIDERS.includes(provider)) {
    return json({ success: false, error: "Unknown TV provider" }, 400);
  }
  if (!/^\d{6,20}$/.test(smartcardNumber)) {
    return json({ success: false, error: "Enter a valid smartcard number" }, 400);
  }

  try {
    const result = await verifyCableTVSmartcard(String(VTUNAIJA_CABLE_IDS[provider]), smartcardNumber);
    const verified = normalizeCableTVSmartcardVerification(result);
    console.info("TV verification response shape", {
      provider,
      full_details_type: Array.isArray(result?.Full_Details) ? "array" : typeof result?.Full_Details,
      has_account_status: verified.accountStatus !== null,
      has_due_date: verified.dueDate !== null,
      has_current_bouquet: verified.currentBouquet !== null,
      has_renewal_amount: verified.renewalAmount !== null,
    });
    if (!verified.ok) {
      return json({
        success: false,
        error: `This smartcard number could not be verified for ${provider.toUpperCase()}. Please check it and try again.`,
      });
    }
    const rawCustomerName = typeof result?.Customer_Name === "string"
      ? result.Customer_Name.trim().slice(0, 200)
      : verified.customerName;
    const { error: saveError } = await supabase.from("saved_billing_accounts").upsert({
      user_id: user.id,
      service: "tv",
      provider_id: provider,
      account_number: smartcardNumber,
      customer_name: verified.customerName,
      provider_customer_name: rawCustomerName,
      last_verified_at: new Date().toISOString(),
      last_used_at: new Date().toISOString(),
    }, { onConflict: "user_id,service,provider_id,account_number" });
    if (saveError) console.error("Could not save verified TV account:", saveError.code);
    return json({
      success: true,
      customer_name: verified.customerName,
      account_status: verified.accountStatus,
      due_date: verified.dueDate,
      current_bouquet: verified.currentBouquet,
      renewal_amount: verified.renewalAmount,
    });
  } catch (error) {
    console.error("verify-tv-smartcard failed:", redactSecrets(error));
    return json({
      success: false,
      error: "Could not verify this smartcard number right now. Please try again.",
    }, 503);
  }
});
