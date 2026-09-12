import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  isServiceEnabled,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";
import { createDirectBankTransfer, isFlutterwaveConfigured, resolveFlutterwaveAccount } from "../_shared/flutterwave-client.ts";
import {
  createPaystackTransferRecipient,
  initiatePaystackTransfer,
  isPaystackConfigured,
  listPaystackBanks,
  resolvePaystackAccount,
} from "../_shared/paystack-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Transfer: sends real NGN from the customer's KaysPay wallet to an
// external bank account. The FIRST outbound-money feature in this app �?// follows vtu-purchase's exact discipline (debit before calling the
// provider, fully awaited, never backgrounded; idempotency short-circuit
// BEFORE the PIN token is spent; ambiguous outcomes stay pending for the
// webhook/reconcile sweep to settle, never auto-refunded).
//
// Flutterwave's /direct-transfers only ever returns "accepted", never
// "settled" �?real settlement always arrives later via the
// transfer.disburse webhook (see flutterwave-transfer-webhook), so a
// successful call here still leaves the transaction pending. There is no
// synchronous-success path for this feature, unlike VTU.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// MUST stay strictly alphanumeric �?this value is sent to Flutterwave as
// the transfer `reference`, and Flutterwave rejects anything containing
// underscores/dashes with "reference: must be an alphanumeric string".
// (crypto.randomUUID().slice(0, 8) is the leading hex block, before the
// first dash, so it's already safe.)
function newRequestId() {
  return `kspxfer${Date.now()}${crypto.randomUUID().slice(0, 8)}`;
}

// Flutterwave's top-level error.message is often a generic "Request is not
// valid" �?the actually useful reason is in error.validation_errors. Same
// helper already used in create-virtual-account/index.ts.
function flwErrorMessage(data: any, fallback: string): string {
  const details = data?.error?.validation_errors
    ?.map((v: any) => `${v.field_name}: ${v.message}`)
    .join("; ");
  return details || data?.error?.message || data?.message || fallback;
}

// Flutterwave and Paystack use different, incompatible bank code schemes �?// this maps a bank by NAME instead of trusting the Flutterwave code carries
// over. Strips common suffixes ("plc", "bank", "nigeria", "limited") that
// vary between the two providers' listings for the same institution.
function normalizeBankName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(plc|bank|nigeria|limited|ltd|mfb|microfinance)\b/g, "")
    .replace(/[^a-z0-9]/g, "")
    .trim();
}

async function findPaystackBankCode(bankName: string): Promise<string | null> {
  const banks = await listPaystackBanks();
  const target = normalizeBankName(bankName);
  if (!target) return null;
  const exact = banks.find((b) => normalizeBankName(b.name) === target);
  if (exact) return exact.code;
  // Fallback to a substring match (e.g. "PalmPay" vs "PalmPay MFB") �?still
  // backed by the account-name comparison after resolve, so an imprecise
  // match here can't result in money going to the wrong place.
  const partial = banks.find((b) => normalizeBankName(b.name).includes(target) || target.includes(normalizeBankName(b.name)));
  return partial?.code ?? null;
}

function namesRoughlyMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean).sort().join(" ");
  return norm(a) === norm(b);
}

function paystackErrorMessage(data: any, fallback: string): string {
  return data?.message || fallback;
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

  if (!(await isServiceEnabled(supabase, "transfer"))) {
    return json({ success: false, error: "Transfers are temporarily unavailable. Please try again later." }, 503);
  }

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  const rate = await enforceRateLimit(supabase, "wallet_transfer", user.id, 10, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many transfer attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const accountNumber = String(body.account_number || "").trim();
  const bankCode = String(body.bank_code || "").trim();
  const bankName = String(body.bank_name || "").trim();
  const ngnAmount = Number(body.amount);
  if (!/^\d{10}$/.test(accountNumber)) {
    return json({ success: false, error: "Enter a valid 10-digit account number." }, 400);
  }
  if (!bankCode || !bankName) {
    return json({ success: false, error: "Select a bank." }, 400);
  }
  if (!Number.isFinite(ngnAmount) || ngnAmount <= 0) {
    return json({ success: false, error: "Enter a valid amount." }, 400);
  }
  const amountKobo = Math.round(ngnAmount * 100);

  // Strip anything non-alphanumeric from a client-supplied key rather than
  // trusting it verbatim: Flutterwave rejects a reference containing
  // underscores/dashes outright, and older app builds (pre-OTA) still mint
  // keys in the old `transfer_<ts>_<rand>` shape. Stripping is safe for
  // idempotency �?it's a deterministic mapping, so a genuine retry of the
  // same request still collapses onto the same key.
  const rawRequestId = String(body.idempotency_key || "").replace(/[^a-zA-Z0-9]/g, "");
  const requestId = rawRequestId || newRequestId();

  // Idempotency short-circuit BEFORE the PIN/biometric token is spent �?  // same discipline as vtu-purchase: a retry of an already-resolved (or
  // still in-flight) request costs nothing.
  const { data: existingTx } = await supabase
    .from("transactions")
    .select("id, status, amount_ngn")
    .eq("metadata->>idempotency_key", requestId)
    .maybeSingle();

  if (existingTx) {
    if (existingTx.status === "completed") {
      return json({ success: true, transaction_id: existingTx.id, amount: existingTx.amount_ngn });
    }
    if (existingTx.status === "refunded" || existingTx.status === "failed") {
      return json({ success: false, error: "This transfer already failed and was refunded. Please start a new transfer." });
    }
    return json({
      success: true,
      pending: true,
      transaction_id: existingTx.id,
      message: "Your transfer is still processing. You'll be notified once it completes.",
    });
  }

  // Never trust a client-supplied recipient name �?re-resolve server-side
  // right before spending anything, so what we send to and what the
  // customer confirmed can't have silently drifted apart.
  let recipientName: string;
  try {
    const resolveRes = await resolveFlutterwaveAccount(supabase, { accountNumber, bankCode });
    if (resolveRes.status >= 400 || resolveRes.data?.status !== "success" || !resolveRes.data?.data?.account_name) {
      return json({ success: false, error: "Could not verify this account. Please check the number and bank." }, 400);
    }
    recipientName = String(resolveRes.data.data.account_name);
  } catch (e) {
    console.error("transfer-send: account resolve failed:", redactSecrets(e));
    return json({ success: false, error: "Could not verify this account. Please try again." }, 500);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  let txId: string;
  try {
    const { data, error } = await supabase.rpc("debit_for_transfer", {
      p_user_id: user.id,
      p_amount: amountKobo,
      p_recipient_name: recipientName,
      p_recipient_account_number: accountNumber,
      p_recipient_bank_code: bankCode,
      p_recipient_bank_name: bankName,
      p_provider: "flutterwave",
      p_idempotency_key: requestId,
    });
    if (error) throw error;
    txId = data as string;
  } catch (e: any) {
    const code = String(e?.message || e);
    console.error("transfer-send: debit_for_transfer failed:", redactSecrets(code));
    if (code.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient wallet balance for this transfer." });
    }
    if (code.includes("DAILY_LIMIT_EXCEEDED")) {
      return json({ success: false, error: "You've reached today's transfer limit. Please try again tomorrow." });
    }
    if (code.includes("INVALID_AMOUNT")) {
      return json({ success: false, error: "Enter an amount within the allowed transfer range." });
    }
    if (code.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "We couldn't find your wallet. Please contact support." });
    }
    if (code.includes("KYC_NOT_VERIFIED")) {
      return json({ success: false, error: "Complete your identity verification to continue.", code: "KYC_REQUIRED" });
    }
    if (code.includes("IDEMPOTENCY_KEY_REUSE")) {
      return json({ success: false, error: "This request could not be processed. Please try again." }, 409);
    }
    // Genuinely unexpected �?surface the redacted reason instead of a blind
    // "try again" so this class of bug (a real SQL/config issue, not a
    // business-rule rejection) doesn't have to be re-diagnosed from logs
    // alone, same fix already applied to crypto-buy.
    return json({ success: false, error: `Could not start the transfer: ${redactSecrets(code)}` }, 500);
  }

  try {
    const transferRes = await createDirectBankTransfer(supabase, {
      amountKobo,
      accountNumber,
      bankCode,
      reference: requestId,
      narration: `KaysPay transfer to ${recipientName}`.slice(0, 100),
    }, requestId);

    if (transferRes.status < 400 && transferRes.data?.status === "success" && transferRes.data?.data?.id) {
      // Accepted, not yet settled �?transfer.disburse (matched on this same
      // idempotency_key, which we sent as Flutterwave's own `reference`)
      // is what actually completes it. The transfer's own `id` is stored
      // for transfer-reconcile, which has to look this up by id �?GET
      // /transfers has no filter-by-reference (confirmed against
      // Flutterwave's own v4 docs).
      const { data: currentTxMeta } = await supabase.from("transactions").select("metadata").eq("id", txId).maybeSingle();
      await supabase
        .from("transactions")
        .update({ metadata: { ...(currentTxMeta?.metadata as object ?? {}), flutterwave_transfer_id: String(transferRes.data.data.id) } })
        .eq("id", txId);
      return json({
        success: true,
        pending: true,
        transaction_id: txId,
        recipient_name: recipientName,
        message: "Your transfer is processing. You'll be notified once it completes.",
      });
    }

    // Flutterwave explicitly rejected the request. The account itself was
    // already verified (via resolveFlutterwaveAccount, before any money
    // moved), so this is almost always something on Flutterwave's own side
    // (balance, a dashboard setting, a transient issue) rather than a bad
    // recipient �?worth trying the same transfer through Paystack before
    // giving up and refunding.
    const flwRejectReason = flwErrorMessage(transferRes.data, "provider_rejected");
    console.error("transfer-send: Flutterwave rejected the transfer:", redactSecrets(JSON.stringify({ status: transferRes.status, message: flwRejectReason })));

    if (isPaystackConfigured()) {
      try {
        const paystackBankCode = await findPaystackBankCode(bankName);
        if (paystackBankCode) {
          const resolveRes = await resolvePaystackAccount({ accountNumber, bankCode: paystackBankCode });
          const resolvedName = resolveRes.data?.data?.account_name;
          if (resolveRes.status < 400 && resolveRes.data?.status === true && resolvedName && namesRoughlyMatch(resolvedName, recipientName)) {
            const recipientRes = await createPaystackTransferRecipient({
              name: recipientName,
              accountNumber,
              bankCode: paystackBankCode,
            });
            const recipientCode = recipientRes.data?.data?.recipient_code;
            if (recipientRes.status < 400 && recipientRes.data?.status === true && recipientCode) {
              const sendRes = await initiatePaystackTransfer({
                amountKobo,
                recipientCode: String(recipientCode),
                reference: requestId,
                reason: `KaysPay transfer to ${recipientName}`.slice(0, 100),
              });
              const sendStatus = String(sendRes.data?.data?.status || "");
              if (sendRes.status < 400 && sendRes.data?.status === true && (sendStatus === "success" || sendStatus === "pending")) {
                // Accepted, not yet settled �?paystack-webhook's
                // transfer.success/failed (matched on this same reference)
                // is what actually completes it, same pattern as Flutterwave.
                const { data: currentTx } = await supabase.from("transactions").select("metadata").eq("id", txId).maybeSingle();
                await supabase
                  .from("transactions")
                  .update({ metadata: { ...(currentTx?.metadata as object ?? {}), actual_provider: "paystack", flutterwave_reject_reason: flwRejectReason } })
                  .eq("id", txId);
                return json({
                  success: true,
                  pending: true,
                  transaction_id: txId,
                  recipient_name: recipientName,
                  message: "Your transfer is processing. You'll be notified once it completes.",
                });
              }
              console.error("transfer-send: Paystack fallback also rejected the transfer:", redactSecrets(JSON.stringify({ status: sendRes.status, message: paystackErrorMessage(sendRes.data, "rejected") })));
            } else {
              console.error("transfer-send: Paystack recipient creation failed during fallback:", redactSecrets(JSON.stringify({ status: recipientRes.status, message: paystackErrorMessage(recipientRes.data, "recipient_failed") })));
            }
          } else {
            console.error("transfer-send: Paystack fallback aborted �?account name mismatch or resolve failed", redactSecrets(JSON.stringify({ resolvedName, expected: recipientName })));
          }
        }
      } catch (fallbackError) {
        console.error("transfer-send: Paystack fallback threw:", redactSecrets(fallbackError));
      }
    }

    // Both providers failed (or Paystack wasn't usable for this bank) �?no
    // money left KaysPay either way, safe to refund.
    await confirmServiceRefund(supabase, txId, flwRejectReason, "automatic");
    return json({ success: false, error: `The bank rejected this transfer: ${redactSecrets(flwRejectReason)}. You were not charged.` });
  } catch (e) {
    // Network/timeout/parse error �?genuinely ambiguous, the request may
    // have reached Flutterwave and been actioned with only the response
    // lost. Hold pending; the webhook or a future reconcile sweep settles it.
    console.error("transfer-send: provider call failed, leaving pending:", redactSecrets(e));
    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      message: "Your transfer is still processing. You'll be notified once it completes.",
    });
  }
});
