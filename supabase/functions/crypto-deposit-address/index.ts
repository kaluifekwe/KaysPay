import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, getAuthUser, isDeviceSessionAllowed, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { getOrCreateCryptoAccount } from "../_shared/crypto-account.ts";
import { createDepositAddress, isQuidaxConfigured } from "../_shared/quidax-client.ts";

// Generates (or returns the existing) deposit address on the user's OWN
// Quidax sub-account for a given network — this is how a user brings crypto
// they already hold elsewhere (Binance, Bybit, etc.) into KaysPay. Quidax
// credits the deposit straight into their sub-account; nothing here ever
// touches a KaysPay-held balance.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// App-facing network keys (matches crypto.service.ts) -> Quidax's own codes.
const NETWORK_MAP: Record<string, string> = {
  TRC20: "trc20",
  ERC20: "erc20",
  BEP20: "bep20",
};
const CURRENCY = "usdt";

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isQuidaxConfigured()) {
    return json({ success: false, error: "Crypto isn't available yet." }, 503);
  }

  let body: any;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const network = NETWORK_MAP[String(body.network || "")];
  if (!network) {
    return json({ success: false, error: "Unsupported network" }, 400);
  }

  const supabase = adminClient();

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  try {
    const account = await getOrCreateCryptoAccount(supabase, user);
    const address = await createDepositAddress({
      quidaxUserId: account.quidaxUserId,
      currency: CURRENCY,
      network,
    });
    return json({ success: true, address: address.address, network: body.network, currency: "USDT" });
  } catch (e) {
    // Provider detail stays in the logs, never in the client response.
    console.error("crypto-deposit-address failed:", e instanceof Error ? e.message : e);
    return json({ success: false, error: "Could not generate a deposit address. Please try again." }, 500);
  }
});
