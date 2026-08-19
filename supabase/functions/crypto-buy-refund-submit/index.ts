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
import {
  isQuidaxRampConfigured,
  QuidaxRampError,
  submitRefundDetails,
  verifyRefundAccount,
} from "../_shared/quidax-ramp-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Submits the customer's bank account as the destination for a refund Quidax
// already decided to make (their own name-mismatch auto-refund on a Buy —
// see crypto-ramp-webhook's buy_transaction.refund.details_requested
// handler). Re-resolves the account server-side rather than trusting
// whatever name the client displayed on the previous screen — the same
// discipline transfer-send uses before spending money, applied here even
// though this function itself moves nothing; it only tells Quidax where to
// send what they already committed to sending back.
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

  const rate = await enforceRateLimit(supabase, "crypto_refund_submit", user.id, 10, 300, user.id);
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
    .select("id, status, metadata")
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .eq("type", "crypto_buy")
    .maybeSingle();

  if (!tx) return json({ success: false, error: "Purchase not found." }, 404);

  // Already submitted (e.g. a double-tap) — nothing left to do, and calling
  // Quidax's submit endpoint a second time isn't something to risk.
  if (tx.status === "pending" && tx.metadata?.needs_refund_bank_details === false && tx.metadata?.refund_bank_code) {
    return json({ success: true, already_submitted: true });
  }
  if (tx.status !== "pending" || tx.metadata?.needs_refund_bank_details !== true) {
    return json({ success: false, error: "No refund is pending for this purchase." }, 404);
  }

  const merchantReference = String(tx.metadata?.quidax_merchant_reference || "");
  if (!merchantReference) {
    return json({ success: false, error: "This purchase is missing its reference." }, 500);
  }

  try {
    const account = await verifyRefundAccount({ merchantReference, accountNumber, bankCode });
    await submitRefundDetails({
      merchantReference,
      accountNumber: account.accountNumber,
      bankCode: account.bankCode,
      accountName: account.accountName,
    });
    const { error } = await supabase.rpc("record_crypto_buy_refund_submitted", {
      p_merchant_reference: merchantReference,
      p_bank_code: account.bankCode,
      p_account_number: account.accountNumber,
      p_account_name: account.accountName,
    });
    if (error) {
      console.error("crypto-buy-refund-submit: record_crypto_buy_refund_submitted failed:", error.message);
      // Quidax already has the details even though our own record didn't
      // save — don't tell the customer to retry and risk a duplicate
      // submission to Quidax over an ambiguous outcome.
      return json({
        success: true,
        account_name: account.accountName,
        warning: "Submitted, but we couldn't update your order — contact support if this doesn't clear soon.",
      });
    }
    return json({ success: true, account_name: account.accountName });
  } catch (e) {
    const message = e instanceof QuidaxRampError
      ? redactSecrets(e.message) || "Could not submit your refund details."
      : "Could not submit your refund details. Please try again.";
    console.error("crypto-buy-refund-submit failed:", redactSecrets(e));
    return json({ success: false, error: message }, 400);
  }
});
