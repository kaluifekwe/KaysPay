import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { deriveVerifiedQuidaxIdentity, getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { getCryptoWithdrawalFee, getSubAccountWallets } from "../_shared/quidax-client.ts";
import {
  attachOffRampBankAccount,
  initiateOffRamp,
  isQuidaxRampConfigured,
  OffRampNameMismatchError,
} from "../_shared/quidax-ramp-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Resolves a bank account BEFORE a Sell, so the customer sees the account
// name confirmed while still filling in the form �?matches Transfer's
// verify-before-commit UX, added after the owner asked for it specifically
// (the first version of Sell only checked at submit time). Rate-limited on
// its own �?same account-number-to-name enumeration surface as
// transfer-resolve-account.
//
// Off-ramp has no standalone "verify" endpoint �?the only way to check a
// name match IS to initiate + attach a bank account for real. This does
// exactly that with a throwaway reference; the customer's real Sell later
// runs its own separate initiate+attach with a fresh reference, so this
// probe never shares state with (or blocks) the actual sale. No crypto ever
// moves here �?confirm/withdraw only happen in crypto-sell itself.
//
// Must match crypto-sell/index.ts's own MIN_USDT/MAX_USDT exactly: this
// probe used to only check crypto_amount > 0, so an amount below Quidax's
// real minimum (e.g. 0.9) still got sent to their off-ramp initiate call,
// which rejected it with a bare "Invalid amount" �?surfacing here as the
// generic "Could not verify this account" and wrongly pointing the
// customer at their bank details instead of the amount they typed.
const MIN_USDT = 1;
const MAX_USDT = 2000;
// Must match crypto-sell's USDT_NETWORK — this path also quotes the fee back
// to the customer. See the note there: BEP20 costs $0.02 against TRC20's $1.00.
const USDT_NETWORK = "bep20";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
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
  if (!Number.isFinite(cryptoAmount) || cryptoAmount < MIN_USDT || cryptoAmount > MAX_USDT) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT} and ${MAX_USDT} USDT` }, 400);
  }

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);
    const identity = await deriveVerifiedQuidaxIdentity(supabase, user);
    if (!identity) {
      return json({ success: false, error: "Complete identity verification before selling crypto to a bank account." }, 403);
    }

    // Do not create a throwaway off-ramp probe unless the requested sale is
    // financially possible. Quidax charges the withdrawal/network fee on top
    // of the amount being sold, so validating only `cryptoAmount` still lets a
    // full-balance sale create an abandoned provider record.
    const [wallets, withdrawalFee] = await Promise.all([
      getSubAccountWallets(account.quidaxUserId),
      getCryptoWithdrawalFee({ currency: "USDT", amount: cryptoAmount, network: USDT_NETWORK }),
    ]);
    const usdt = wallets.find((wallet) => wallet.currency.toLowerCase() === "usdt");
    const available = Number(usdt?.balance ?? 0);
    const totalRequired = cryptoAmount + withdrawalFee.fee;
    if (!Number.isFinite(available) || available + 1e-8 < totalRequired) {
      return json({
        success: false,
        error: `You need ${totalRequired.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")} USDT: ${cryptoAmount} USDT to sell plus ${withdrawalFee.fee} USDT network fee.`,
        network_fee: withdrawalFee.fee,
        total_required: totalRequired,
        available: Number.isFinite(available) ? available : 0,
      }, 400);
    }

    const merchantReference = `probe${Date.now()}${crypto.randomUUID().slice(0, 8)}`;
    await initiateOffRamp({
      merchantReference,
      cryptoAmount,
      asset: "USDT",
      network: USDT_NETWORK,
      email: identity.email,
      firstName: identity.firstName,
      lastName: identity.lastName,
    });

    let attached: { accountName: string | null };
    try {
      // The bank-account endpoint is keyed by the merchant_reference we
      // supplied at initiation, not Quidax's separate TRX reference. The
      // real Sell path already follows this contract; using the TRX value
      // here made valid Nigerian accounts fail the pre-sale verification.
      attached = await attachOffRampBankAccount({ merchantReference, bankCode, accountNumber });
    } catch (e) {
      if (e instanceof OffRampNameMismatchError) {
        return json({ success: false, error: "This account's registered name doesn't match your KaysPay profile." });
      }
      throw e;
    }

    return json({ success: true, account_name: attached.accountName || `${identity.firstName} ${identity.lastName}` });
  } catch (e) {
    console.error("crypto-sell-resolve-account failed:", redactSecrets(e));
    const providerMessage = e instanceof Error ? redactSecrets(e.message).trim() : "";
    return json({
      success: false,
      error: providerMessage || "Could not verify this account. Please try again.",
    }, 500);
  }
});
