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
import { createWithdrawal, getCryptoWithdrawalFee, getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";
import { DUST_FLOOR, maxWithdrawInAssetUnits, resolveWithdrawTarget } from "../_shared/crypto-withdraw-assets.ts";

// Withdraw crypto from the user's OWN Quidax sub-account to an external
// wallet address. Quidax debits their sub-account balance directly �?no
// local crypto ledger is touched, since the balance the app shows is read
// live from Quidax and debiting here too would double-count. USDT keeps its
// multi-network shape (customer picks TRC20/ERC20/BEP20); every other
// supported asset withdraws over its own single native chain, see
// _shared/crypto-withdraw-assets.ts for exactly which and why.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Real minimum is always computed live per network from Quidax's own fee
// (mirrors crypto-withdraw-quote exactly, so the client is never quoted one
// number and charged another) -- capped so the fee can never exceed
// MAX_FEE_SHARE of what's being sent.
const MAX_FEE_SHARE = 0.2;

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

  const address = String(body.address || "").trim();
  const cryptoAmount = Number(body.crypto_amount);

  const target = resolveWithdrawTarget(String(body.asset || "USDT"), String(body.network || ""));
  if (!target) {
    return json({ success: false, error: "Unsupported asset or network" }, 400);
  }
  const { asset, networkLabel, config } = target;
  const dustFloor = DUST_FLOOR[asset] ?? DUST_FLOOR.USDT;

  if (!config.addressPattern.test(address)) {
    return json({ success: false, error: `This doesn't look like a valid ${networkLabel} address.` }, 400);
  }
  if (!Number.isFinite(cryptoAmount) || cryptoAmount <= 0) {
    return json({ success: false, error: "Enter a valid amount." }, 400);
  }

  // Fail closed BEFORE any PIN-token side effect �?a blocked withdrawal
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

    const [wallets, withdrawalFee, maxWithdraw] = await Promise.all([
      getSubAccountWallets(account.quidaxUserId),
      // Quidax deducts the network fee ON TOP of `amount` (the same
      // withdrawal call crypto-sell makes to its own off-ramp deposit
      // address — see that function's own note on this exact mechanic).
      // Never trust the client's minimum: re-verified here from scratch so
      // a stale quote, or a request that skipped the quote step entirely,
      // can't slip a fee-eating amount through.
      getCryptoWithdrawalFee({ currency: config.quidaxCurrency, amount: cryptoAmount, network: config.quidaxNetwork }),
      maxWithdrawInAssetUnits(config.quidaxCurrency),
    ]);
    const wallet = wallets.find((w) => w.currency.toLowerCase() === config.quidaxCurrency);
    const available = Number(wallet?.balance ?? 0);
    const fee = withdrawalFee.fee;
    const totalRequired = cryptoAmount + fee;

    if (cryptoAmount > maxWithdraw) {
      return json({
        success: false,
        error: `Enter an amount up to ${maxWithdraw.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ${asset}.`,
      }, 400);
    }

    const minForNetwork = Math.max(dustFloor, fee / MAX_FEE_SHARE);
    if (cryptoAmount < minForNetwork) {
      return json({
        success: false,
        error: `Enter at least ${minForNetwork} ${asset} for ${networkLabel} — the network fee makes anything smaller not worth sending.`,
        min_for_network: minForNetwork,
        network_fee: fee,
      });
    }

    if (!Number.isFinite(available) || available + 1e-8 < totalRequired) {
      return json({
        success: false,
        error: `You need ${totalRequired.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")} ${asset}: ${cryptoAmount} ${asset} to withdraw plus ${fee} ${asset} network fee.`,
        network_fee: fee,
      });
    }

    // Recorded BEFORE the send, so an on-chain transfer can never happen
    // without a row for the webhook to settle against.
    const { data: txId, error: recordError } = await supabase.rpc("record_crypto_withdrawal_pending", {
      p_user_id: user.id,
      p_asset: asset,
      p_crypto_micro: cryptoMicro,
      p_network: networkLabel,
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
        currency: config.quidaxCurrency,
        amount: String(cryptoAmount),
        fundUid: address,
        reference,
        network: config.quidaxNetwork,
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
