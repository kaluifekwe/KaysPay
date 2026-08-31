import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser, isDeviceSessionAllowed } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";

// Called when the Crypto screen loads: ensures the user has a Quidax
// sub-account (creating one on first visit) and returns their LIVE wallet
// balances straight from Quidax â€?never a KaysPay-held number, since their
// crypto lives entirely under their own sub-account, not a pooled ledger.
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

  if (!isQuidaxConfigured()) {
    return json({ success: false, error: "Crypto isn't available yet." }, 503);
  }

  const supabase = adminClient();

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  // Fetches sub-account wallets from the exchange on every call.
  const rate = await enforceRateLimit(supabase, "crypto_account", user.id, 30, 60, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Please wait a moment and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);
    const wallets = await getSubAccountWallets(account.quidaxUserId);
    const ngnWallet = wallets.find((wallet) => wallet.currency.toUpperCase() === "NGN");
    const ngnBalance = Number(ngnWallet?.balance ?? 0);

    // New sales settle directly to the customer's verified bank and should
    // not leave NGN in their Quidax sub-account. A positive balance can be
    // legacy sale proceeds whose old consolidation sweep failed. Raise one
    // deduplicated operational alert for investigation; never move or credit
    // money here because that could duplicate a settlement already credited
    // to the KaysPay wallet.
    if (Number.isFinite(ngnBalance) && ngnBalance > 0) {
      const { error: alertError } = await supabase.rpc("record_monitoring_alert", {
        p_fingerprint: `crypto_ngn_stranded_${user.id}`,
        p_type: "crypto_ngn_stranded",
        p_severity: "warning",
        p_details: {
          user_id: user.id,
          quidax_account_id: account.quidaxUserId,
          ngn_balance: ngnBalance,
          detected_at: new Date().toISOString(),
        },
      });
      if (alertError) console.error("crypto-account: could not record stranded NGN alert:", alertError.message);
    }
    return json({
      success: true,
      wallets: wallets.map((w) => ({
        currency: w.currency,
        balance: w.balance,
        locked: w.locked,
        is_crypto: w.isCrypto,
      })),
    });
  } catch (e) {
    // Provider detail stays in the logs, never in the client response.
    console.error("crypto-account failed:", e instanceof Error ? e.message : e);
    return json({ success: false, error: "Could not load your crypto account. Please try again." }, 500);
  }
});
