import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { deriveVerifiedQuidaxIdentity } from "../_shared/crypto-account.ts";
import {
  attachOffRampBankAccount,
  initiateOffRamp,
  isQuidaxRampConfigured,
  OffRampNameMismatchError,
} from "../_shared/quidax-ramp-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Resolves a bank account BEFORE a Sell, so the customer sees the account
// name confirmed while still filling in the form — matches Transfer's
// verify-before-commit UX, added after the owner asked for it specifically
// (the first version of Sell only checked at submit time). Rate-limited on
// its own — same account-number-to-name enumeration surface as
// transfer-resolve-account.
//
// Off-ramp has no standalone "verify" endpoint — the only way to check a
// name match IS to initiate + attach a bank account for real. This does
// exactly that with a throwaway reference; the customer's real Sell later
// runs its own separate initiate+attach with a fresh reference, so this
// probe never shares state with (or blocks) the actual sale. No crypto ever
// moves here — confirm/withdraw only happen in crypto-sell itself.
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

  const rate = await enforceRateLimit(supabase, "crypto_sell_resolve", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const accountNumber = String(body.account_number || "").trim();
  const bankCode = String(body.bank_code || "").trim();
  const cryptoAmount = Number(body.crypto_amount);
  if (!/^\d{10}$/.test(accountNumber)) {
    return json({ success: false, error: "Enter a valid 10-digit account number." }, 400);
  }
  if (!bankCode) {
    return json({ success: false, error: "Select a bank." }, 400);
  }
  if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
    return json({ success: false, error: "Enter an amount first." }, 400);
  }

  try {
    const identity = await deriveVerifiedQuidaxIdentity(supabase, user);
    if (!identity) {
      return json({ success: false, error: "Complete identity verification before selling crypto to a bank account." }, 403);
    }
    const initiated = await initiateOffRamp({
      merchantReference: `probe${Date.now()}${crypto.randomUUID().slice(0, 8)}`,
      cryptoAmount,
      asset: "USDT",
      network: "trc20",
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
    });

    let attached: { accountName: string | null };
    try {
      attached = await attachOffRampBankAccount({ merchantReference: initiated.reference, bankCode, accountNumber });
    } catch (e) {
      if (e instanceof OffRampNameMismatchError) {
        return json({ success: false, error: "This account's registered name doesn't match your KaysPay profile." });
      }
      throw e;
    }

    return json({ success: true, account_name: attached.accountName || `${identity.firstName} ${identity.lastName}` });
  } catch (e) {
    console.error("crypto-sell-resolve-account failed:", redactSecrets(e));
    return json({ success: false, error: "Could not verify this account. Please try again." }, 500);
  }
});
