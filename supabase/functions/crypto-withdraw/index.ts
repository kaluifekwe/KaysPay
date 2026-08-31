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
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { createWithdrawal, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";

// Withdraw USDT from the user's OWN Quidax sub-account to an external
// wallet address. Quidax debits their sub-account balance directly â€?no
// local crypto ledger is touched, since the balance the app shows is read
// live from Quidax and debiting here too would double-count.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Same format rules as crypto.service.ts's client-side check â€?never trust
// the client's own validation for what's ultimately an irreversible send.
const ADDRESS_PATTERNS: Record<string, RegExp> = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ERC20: /^0x[a-fA-F0-9]{40}$/,
  BEP20: /^0x[a-fA-F0-9]{40}$/,
};

// App-facing network keys -> Quidax's own network codes.
const NETWORK_MAP: Record<string, string> = {
  TRC20: "trc20",
  ERC20: "erc20",
  BEP20: "bep20",
};

const MIN_USDT = 5;
const MAX_USDT = 2000;

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const asset = String(body.asset || "USDT");
  const network = String(body.network || "");
  const address = String(body.address || "").trim();
  const cryptoAmount = Number(body.crypto_amount);

  if (asset !== "USDT") {
    return json({ success: false, error: "Unsupported asset" }, 400);
  }
  const pattern = ADDRESS_PATTERNS[network];
  const quidaxNetwork = NETWORK_MAP[network];
  if (!pattern || !quidaxNetwork) {
    return json({ success: false, error: "Unsupported network" }, 400);
  }
  if (!pattern.test(address)) {
    return json({ success: false, error: `This doesn't look like a valid ${network} address.` }, 400);
  }
  if (!Number.isFinite(cryptoAmount) || cryptoAmount < MIN_USDT || cryptoAmount > MAX_USDT) {
    return json({ success: false, error: `Enter an amount between ${MIN_USDT} and ${MAX_USDT} USDT` }, 400);
  }

  // Fail closed BEFORE any PIN-token side effect â€?a blocked withdrawal
  // must never look or feel like it partially happened.
  if (!isQuidaxConfigured()) {
    return json({
      success: false,
      error: "Crypto withdrawals aren't live yet. We'll notify you the moment they are.",
    }, 503);
  }

  const supabase = adminClient();

  if (!(await isServiceEnabled(supabase, "crypto_withdraw"))) {
    return json({ success: false, error: "Crypto withdrawals are temporarily unavailable." }, 503);
  }

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  const rate = await enforceRateLimit(supabase, "crypto_withdraw", user.id, 10, 600, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  const cryptoMicro = Math.round(cryptoAmount * 1_000_000);
  // Doubles as Quidax's own `reference`, so a retry of the same request can
  // never send twice.
  const reference = String(body.idempotency_key || `crypto_wd_${user.id}_${Date.now()}`);

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);

    const wallets = await getSubAccountWallets(account.quidaxUserId);
    const usdt = wallets.find((w) => w.currency.toLowerCase() === "usdt");
    const available = Number(usdt?.balance ?? 0);
    if (!Number.isFinite(available) || available < cryptoAmount) {
      return json({ success: false, error: "Insufficient USDT balance." });
    }

    // Recorded BEFORE the send, so an on-chain transfer can never happen
    // without a row for the webhook to settle against.
    const { data: txId, error: recordError } = await supabase.rpc("record_crypto_withdrawal_pending", {
      p_user_id: user.id,
      p_asset: asset,
      p_crypto_micro: cryptoMicro,
      p_network: network,
      p_address: address,
      p_reference: reference,
    });
    if (recordError) {
      console.error("crypto-withdraw: could not record pending withdrawal:", recordError.message);
      return json({ success: false, error: "Could not start the withdrawal. Please try again." }, 500);
    }

    try {
      await createWithdrawal({
        quidaxUserId: account.quidaxUserId,
        currency: "usdt",
        amount: String(cryptoAmount),
        fundUid: address,
        reference,
        network: quidaxNetwork,
      });
    } catch (sendError) {
      await supabase.rpc("settle_crypto_withdrawal", {
        p_reference: reference,
        p_succeeded: false,
        p_txid: null,
        p_reason: "provider_rejected",
      });
      const detail = sendError instanceof Error ? sendError.message : String(sendError);
      console.error("crypto-withdraw: provider rejected:", detail);
      return json({ success: false, error: "Withdrawal failed. Your balance was not touched." });
    }

    return json({
      success: true,
      pending: true,
      transaction_id: txId,
      message: "Your withdrawal is processing. You'll be notified once it completes.",
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    console.error("crypto-withdraw failed:", detail);
    return json({ success: false, error: "Could not start the withdrawal. Please try again." }, 500);
  }
});
