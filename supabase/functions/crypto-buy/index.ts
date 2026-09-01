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
import { getUsdNgnRate } from "../_shared/esim-catalog.ts";
import { createDepositAddress, getMarketTicker, isQuidaxConfigured, QuidaxError } from "../_shared/quidax-client.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import {
  confirmOnRamp,
  initiateOnRamp,
  isQuidaxRampConfigured,
  QuidaxRampError,
} from "../_shared/quidax-ramp-client.ts";
import { resolveBuyLimits } from "../_shared/crypto-buy-limits.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Buy (Phase 3): a REAL purchase. Quidax issues a single-use bank account,
// the customer transfers Naira to it from their own bank, and Quidax
// delivers USDT into the customer's own sub-account �?the same balance Sell
// and Withdraw spend from. KaysPay never holds the Naira and never fronts
// liquidity, which is why this does not debit the in-app wallet.
//
// Replaces the legacy internal-ledger buy (migration 082's buy_crypto),
// which credited a number backed by no actual crypto.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Ramp pays out ON-CHAIN even when the destination is a Quidax-hosted
// address — Quidax confirmed (2026-08-31) that an internal credit is not
// possible, so every purchase pays a network fee to move coin from Quidax
// back into Quidax. The network is therefore the only lever on that fee.
//
// This used to say TRC-20 was "the cheapest network to settle on". It is not,
// and that single wrong belief is what made a ₦3,000 purchase deliver barely
// half its value. Quidax's own USDT fee table:
//
//   celo $0.005 · polygon $0.01 · bep20 $0.02 · solana $0.025 · ton $0.035
//   lisk $1.00 · trc20 $1.00 · erc20 $2.00
//
// TRC-20 is joint-most-expensive, beaten only by Ethereum. On a ₦3,000 order
// that $1 was 48% of the customer's money, and on anything under a dollar the
// trade could not execute at all — Quidax keeps that money ("it remains in
// that state"), which is how a ₦2,790 order was lost.
//
// bep20 over the cheaper polygon/celo deliberately: delivery lands in the
// customer's own Quidax sub-account, and crypto-withdraw only offers TRC20,
// ERC20 and BEP20. Choosing a network we can also withdraw on means this is
// safe whether or not Quidax holds one fungible USDT balance per sub-account
// — a question they have not answered. Two cents versus one is not worth
// betting customer funds on the answer.
const DELIVERY_NETWORK = "bep20";

// Same format rules as crypto.service.ts's client-side check and
// crypto-withdraw's server-side check �?never trust the client's own
// validation for what's ultimately an irreversible on-chain send. A wrong
// address here is WORSE than a wrong withdrawal address: there is no
// KaysPay-side balance to recover it from, since Quidax delivers straight
// out of the purchase.
const EXTERNAL_ADDRESS_PATTERNS: Record<string, RegExp> = {
  TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  ERC20: /^0x[a-fA-F0-9]{40}$/,
  BEP20: /^0x[a-fA-F0-9]{40}$/,
};
const EXTERNAL_NETWORK_MAP: Record<string, string> = {
  TRC20: "trc20",
  ERC20: "erc20",
  BEP20: "bep20",
};

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const exchangeConfigured = isQuidaxConfigured();
  const rampConfigured = isQuidaxRampConfigured();
  console.info("crypto-buy configuration", {
    exchange_configured: exchangeConfigured,
    ramp_configured: rampConfigured,
  });

  if (!exchangeConfigured || !rampConfigured) {
    return json({
      success: false,
      error: "Buying crypto isn't available yet. We'll notify you the moment it is.",
    }, 503);
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const supabase = adminClient();

  if (!(await isServiceEnabled(supabase, "crypto"))) {
    return json({ success: false, error: "Crypto is temporarily unavailable. Please try again later." }, 503);
  }

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  const rate = await enforceRateLimit(supabase, "crypto_buy", user.id, 20, 300, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many attempts. Please wait a few minutes and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const asset = String(body.asset || "USDT").trim().toUpperCase();

  // Non-USDT coins are buy-only right now: crypto-sell and crypto-withdraw
  // both hard-reject anything but USDT, and there is no convert/swap path a
  // customer can reach on their own. A completed BTC/ETH/SOL/etc purchase
  // would sit in the account with no exit until Convert ships. Gated
  // server-side (not just hidden client-side) so an older app build, or
  // anyone calling this endpoint directly, cannot create one of those stuck
  // purchases either. Re-enable per-coin once Convert (swap to USDT) lands.
  if (asset !== "USDT") {
    return json({ success: false, error: "This coin isn't available to buy yet. USDT is available now." }, 400);
  }
  const swapAsset = null;

  // Optional: send the purchased USDT straight to an external wallet instead
  // of the customer's own KaysPay crypto account. Validated the same way a
  // withdrawal address is, and rejected outright rather than silently
  // falling back to the KaysPay account �?a customer who typed an address
  // must never have it quietly ignored. Only offered for USDT �?every other
  // supported coin needs a second leg (a swap, settled after this request
  // returns) before the coin exists in the customer's account at all, so
  // there's nothing to send externally yet. v1 keeps that as a manual
  // Withdraw afterward rather than an auto-chained 3rd leg.
  const externalNetworkKey = String(body.destination_network || "").trim();
  const externalAddress = String(body.destination_address || "").trim();
  let external: { network: string; quidaxNetwork: string; address: string } | null = null;
  if (externalNetworkKey || externalAddress) {
    if (swapAsset) {
      return json({
        success: false,
        error: `${swapAsset.name} purchases are delivered to your KaysPay crypto account only for now.`,
      }, 400);
    }
    const pattern = EXTERNAL_ADDRESS_PATTERNS[externalNetworkKey];
    const quidaxNetwork = EXTERNAL_NETWORK_MAP[externalNetworkKey];
    if (!pattern || !quidaxNetwork) {
      return json({ success: false, error: "Unsupported network" }, 400);
    }
    if (!pattern.test(externalAddress)) {
      return json({ success: false, error: `This doesn't look like a valid ${externalNetworkKey} address.` }, 400);
    }
    external = { network: externalNetworkKey, quidaxNetwork, address: externalAddress };
  }

  // Live market price �?also converts a USD-denominated request from the
  // existing screen into the Naira amount Quidax actually charges in.
  let askRate: number;
  try {
    askRate = (await getMarketTicker("usdtngn")).ask;
  } catch (e) {
    console.error("crypto-buy: ticker failed, falling back to FX feed:", e instanceof Error ? e.message : e);
    askRate = await getUsdNgnRate(supabase);
  }

  const requestedNgn = Number(body.ngn_amount);
  const requestedUsd = Number(body.usd_amount);
  const ngnAmount = Number.isFinite(requestedNgn) && requestedNgn > 0
    ? Math.round(requestedNgn)
    : Math.round((Number.isFinite(requestedUsd) ? requestedUsd : 0) * askRate);

  const { minNgn, maxNgn } = await resolveBuyLimits();
  if (!Number.isFinite(ngnAmount) || ngnAmount < minNgn || ngnAmount > maxNgn) {
    return json({
      success: false,
      error: `Enter an amount between ₦${minNgn.toLocaleString("en-NG")} and ₦${maxNgn.toLocaleString("en-NG")}.`,
    }, 400);
  }

  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({ success: false, error: "Re-authorization required. Please try again." }, 401);
  }

  // Reused verbatim on a retry so the customer gets the SAME order and the
  // same bank account back, instead of opening a second one they might also
  // pay into.
  const merchantReference = String(body.idempotency_key || "").trim()
    || `kspbuy_${user.id.replace(/-/g, "").slice(0, 12)}_${Date.now()}`;

  // The idempotency key above only protects an automatic retry of the SAME
  // call — the client mints a fresh key per invocation, so a second tap (or
  // a second session) arrives as a genuinely new request and used to open a
  // second Ramp order, each with its own one-time bank account the customer
  // could pay into. Seen live: two identical orders 190ms apart. Quidax's
  // account expects an EXACT amount, so paying once only ever fulfils one
  // order anyway; the other just sits pending forever. Handing back the
  // order already in flight is what the comment above always intended.
  const DUPLICATE_WINDOW_MS = 2 * 60 * 1000;
  const { data: inFlight } = await supabase
    .from("transactions")
    .select("id, metadata")
    .eq("user_id", user.id)
    .eq("type", "crypto_buy")
    .eq("status", "pending")
    .eq("amount_ngn", Math.round(ngnAmount * 100))
    .eq("metadata->>asset", asset)
    .gte("created_at", new Date(Date.now() - DUPLICATE_WINDOW_MS).toISOString())
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  const inFlightReference = String(inFlight?.metadata?.quidax_merchant_reference || "");
  if (inFlight && inFlightReference) {
    try {
      // Reads the EXISTING Quidax order — never creates one. Bank details
      // aren't fully persisted locally, so they're re-fetched to return the
      // same account the customer was already shown.
      const existingBank = await confirmOnRamp(inFlightReference);
      const md = (inFlight.metadata ?? {}) as Record<string, unknown>;
      return json({
        success: true,
        duplicate: true,
        transaction_id: inFlight.id,
        asset,
        estimated_crypto: Number(md.estimated_crypto_micro ?? 0) / 1_000_000 || undefined,
        pending_swap: !!swapAsset,
        rate: askRate,
        destination_type: md.destination_type ?? (external ? "external_wallet" : "kayspay_account"),
        destination_address: md.destination_address,
        destination_network: external?.network ?? "TRC20",
        payment: {
          account_name: existingBank.accountName,
          account_number: existingBank.accountNumber,
          bank_name: existingBank.bankName,
          amount_to_pay: existingBank.amountExpected,
          amount: existingBank.amount,
          processor_fee: existingBank.processorFee,
          vat: existingBank.vat,
          merchant_markup: existingBank.merchantMarkup,
        },
      });
    } catch (e) {
      // Couldn't read the in-flight order back. Fall through and open a new
      // one rather than block a real purchase — the duplicate risk returns
      // only in this rare error case, which is the safer trade for money.
      console.error("crypto-buy: could not reuse in-flight order:", e instanceof Error ? e.message : e);
    }
  }

  // For a swap-target coin, this leg always delivers USDT (Ramp only ever
  // moves NGN<->USDT) �?the coin itself doesn't exist yet, it's produced by
  // the swap leg once this USDT lands (see crypto-quidax-webhook). The
  // number shown here is therefore a live estimate, re-priced for real at
  // swap time, same "estimate now, settle for real later" shape as the NGN
  // buy amount always was.
  let estimatedSwapCoin: number | null = null;
  if (swapAsset) {
    try {
      const coinTicker = await getMarketTicker(`${swapAsset.quidaxCode}usdt`);
      estimatedSwapCoin = ngnAmount / askRate / coinTicker.ask;
    } catch (e) {
      console.error(`crypto-buy: ${swapAsset.quidaxCode}usdt ticker failed:`, e instanceof Error ? e.message : e);
    }
  }

  // Tracks how far the purchase got. Quidax's exchange and Ramp products
  // return similar-sounding auth errors, so without this a failure log can't
  // say which of the two actually refused us.
  let step = "deposit_address";
  try {
    // Delivery target: an external wallet the customer supplied, or �?by
    // default, and always for a swap-target coin �?their own KaysPay crypto
    // account, so the purchase lands in the same balance Sell and Withdraw
    // already read.
    const deliveryNetwork = external?.quidaxNetwork ?? DELIVERY_NETWORK;
    let deliveryAddress: string;
    if (external) {
      deliveryAddress = external.address;
    } else {
      const account = await getOrCreateCryptoAccount(supabase, user);
      const destination = await createDepositAddress({
        quidaxUserId: account.quidaxUserId,
        currency: "usdt",
        network: DELIVERY_NETWORK,
      });
      deliveryAddress = destination.address;
    }

    // Quidax name-matches this against the bank account the money arrives
    // from, so it must be the customer's real name, not a KaysPay label.
    const fullName = String((user.user_metadata as { full_name?: string } | undefined)?.full_name || "").trim();
    const [firstName, ...rest] = fullName ? fullName.split(/\s+/) : ["KaysPay"];
    const lastName = rest.join(" ") || "User";

    step = "on_ramp_initiate";
    const initiated = await initiateOnRamp({
      merchantReference,
      ngnAmount,
      email: `${user.id}@users.kayspay.com.ng`,
      firstName: firstName.slice(0, 60),
      lastName: lastName.slice(0, 60),
      address: deliveryAddress,
      network: deliveryNetwork,
    });

    step = "on_ramp_confirm";
    const bank = await confirmOnRamp(merchantReference);

    const { data: txId, error } = await supabase.rpc("start_crypto_buy", {
      p_user_id: user.id,
      p_merchant_reference: merchantReference,
      p_ngn_kobo: Math.round(ngnAmount * 100),
      p_estimated_micro: Math.round((swapAsset ? (estimatedSwapCoin ?? 0) : initiated.toAmount) * 1_000_000),
      p_rate: askRate,
      p_asset: asset,
      p_metadata: {
        quidax_public_id: initiated.publicId,
        quidax_reference: initiated.reference,
        crypto_network: deliveryNetwork,
        destination_address: deliveryAddress,
        destination_type: external ? "external_wallet" : "kayspay_account",
        amount_expected_ngn: bank.amountExpected,
        processor_fee_ngn: bank.processorFee,
        vat_ngn: bank.vat,
        merchant_markup_ngn: bank.merchantMarkup,
      },
    });
    if (error) {
      console.error("crypto-buy: start_crypto_buy failed:", error.message);
      return json({ success: false, error: "Could not start the purchase. Please try again." }, 500);
    }

    return json({
      success: true,
      transaction_id: txId,
      asset,
      // For a swap-target coin this is a live estimate only �?the real
      // swap (and its own re-quote) runs after this USDT settles.
      estimated_crypto: swapAsset ? estimatedSwapCoin : initiated.toAmount,
      pending_swap: !!swapAsset,
      rate: askRate,
      destination_type: external ? "external_wallet" : "kayspay_account",
      destination_address: deliveryAddress,
      destination_network: external?.network ?? "TRC20",
      // What the customer must transfer, and exactly where.
      payment: {
        account_name: bank.accountName,
        account_number: bank.accountNumber,
        bank_name: bank.bankName,
        amount_to_pay: bank.amountExpected,
        amount: bank.amount,
        processor_fee: bank.processorFee,
        vat: bank.vat,
        merchant_markup: bank.merchantMarkup,
      },
    });
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Which API refused us, and with what status �?the message alone reads
    // almost identically across Quidax's two products.
    const api = e instanceof QuidaxRampError ? "ramp" : e instanceof QuidaxError ? "exchange" : "other";
    const status = (e as { status?: number })?.status ?? "none";
    console.error(
      `crypto-buy failed [step=${step} api=${api} status=${status}]:`,
      redactSecrets(detail),
    );
    // Quidax's own error message (already just a short human-readable reason
    // from their API response body, never raw request/response internals) is
    // safe and far more useful to show than a blanket "try again" �?it's the
    // difference between the customer knowing to fix their KYC tier vs. just
    // retrying the same failing request forever. Anything else (network
    // failure, timeout, a bug on our side) still falls back to the generic
    // message so we never leak internals.
    const message = e instanceof QuidaxRampError || e instanceof QuidaxError
      ? redactSecrets(e.message) || "Could not start the purchase. Please try again."
      : "Could not start the purchase. Please try again.";
    return json({ success: false, error: message }, 500);
  }
});
