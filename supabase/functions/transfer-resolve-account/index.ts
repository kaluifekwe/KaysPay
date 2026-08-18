import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { isFlutterwaveConfigured, resolveFlutterwaveAccount } from "../_shared/flutterwave-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Resolves a bank account number to its registered holder name BEFORE a
// transfer, so the customer can confirm they're sending to the right person
// instead of trusting a typed-in digit string. Rate-limited on its own —
// this is a real account-number-to-name enumeration surface, not just UX.
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

  if (!isFlutterwaveConfigured()) {
    return json({ success: false, error: "Transfers aren't available yet." }, 503);
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const supabase = adminClient();

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  const rate = await enforceRateLimit(supabase, "transfer_resolve", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const accountNumber = String(body.account_number || "").trim();
  const bankCode = String(body.bank_code || "").trim();
  if (!/^\d{10}$/.test(accountNumber)) {
    return json({ success: false, error: "Enter a valid 10-digit account number." }, 400);
  }
  if (!bankCode) {
    return json({ success: false, error: "Select a bank." }, 400);
  }

  try {
    const res = await resolveFlutterwaveAccount(supabase, { accountNumber, bankCode });
    if (res.status >= 400 || res.data?.status !== "success" || !res.data?.data?.account_name) {
      return json({ success: false, error: "Could not verify this account. Please check the number and bank." }, 400);
    }
    return json({
      success: true,
      account_name: String(res.data.data.account_name),
      account_number: String(res.data.data.account_number ?? accountNumber),
    });
  } catch (e) {
    console.error("transfer-resolve-account failed:", redactSecrets(e));
    return json({ success: false, error: "Could not verify this account. Please try again." }, 500);
  }
});
