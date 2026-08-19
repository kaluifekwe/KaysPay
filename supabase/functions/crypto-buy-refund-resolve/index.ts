import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { isQuidaxRampConfigured, QuidaxRampError, verifyRefundAccount } from "../_shared/quidax-ramp-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Resolves a bank account to its holder's name BEFORE the customer confirms
// it as their refund destination — same "never trust a typed-in number
// alone" discipline as transfer-resolve-account. This is a real
// account-number-to-name enumeration surface, not just UX, hence its own
// rate limit.
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

  if (!isQuidaxRampConfigured()) {
    return json({ success: false, error: "Not available yet." }, 503);
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

  const rate = await enforceRateLimit(supabase, "crypto_refund_resolve", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const transactionId = String(body.transaction_id || "").trim();
  const accountNumber = String(body.account_number || "").trim();
  const bankCode = String(body.bank_code || "").trim();
  if (!transactionId) return json({ success: false, error: "Missing transaction." }, 400);
  if (!/^\d{10}$/.test(accountNumber)) {
    return json({ success: false, error: "Enter a valid 10-digit account number." }, 400);
  }
  if (!bankCode) return json({ success: false, error: "Select a bank." }, 400);

  const { data: tx } = await supabase
    .from("transactions")
    .select("id, metadata")
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .eq("type", "crypto_buy")
    .eq("status", "pending")
    .maybeSingle();

  if (!tx || tx.metadata?.needs_refund_bank_details !== true) {
    return json({ success: false, error: "No refund is pending for this purchase." }, 404);
  }

  const merchantReference = String(tx.metadata?.quidax_merchant_reference || "");
  if (!merchantReference) {
    return json({ success: false, error: "This purchase is missing its reference." }, 500);
  }

  try {
    const account = await verifyRefundAccount({ merchantReference, accountNumber, bankCode });
    return json({
      success: true,
      account_name: account.accountName,
      account_number: account.accountNumber,
      bank_name: account.bankName,
    });
  } catch (e) {
    const message = e instanceof QuidaxRampError
      ? redactSecrets(e.message) || "Could not verify this account."
      : "Could not verify this account. Please try again.";
    console.error("crypto-buy-refund-resolve failed:", redactSecrets(e));
    return json({ success: false, error: message }, 400);
  }
});
