import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, isDeviceSessionAllowed } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { getSubAccountWallets, isQuidaxConfigured } from "../_shared/quidax-client.ts";

// Called when the Crypto screen loads: ensures the user has a Quidax
// sub-account (creating one on first visit) and returns their LIVE wallet
// balances straight from Quidax — never a KaysPay-held number, since their
// crypto lives entirely under their own sub-account, not a pooled ledger.
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

  if (!isQuidaxConfigured()) {
    return json({ success: false, error: "Crypto isn't available yet." }, 503);
  }

  const supabase = adminClient();

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);
    const wallets = await getSubAccountWallets(account.quidaxUserId);
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
    console.error("crypto-account failed:", e instanceof Error ? e.message : e);
    return json({ success: false, error: "Could not load your crypto account. Please try again." }, 500);
  }
});
