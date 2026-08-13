import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { verifyQuidaxWebhookSignature } from "../_shared/quidax-client.ts";

// Receives Quidax's webhook deliveries. Phase 1 only acts on deposit events
// (deposit.successful credits the transaction into History; the on-hold/
// failed/rejected variants are logged for visibility, since Quidax's own
// compliance layer can flag/hold a deposit and there's nothing for KaysPay
// to reconcile until that resolves). Buy/sell/withdraw event handling lands
// in later phases alongside those flows.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  // Signature is computed over the RAW body — must read as text before any
  // JSON parsing, or the signature will never match.
  const rawBody = await req.text();
  const signatureHeader = req.headers.get("quidax-signature");
  const verified = await verifyQuidaxWebhookSignature(rawBody, signatureHeader);
  if (!verified) {
    console.error("crypto-quidax-webhook: signature verification failed");
    return json({ error: "Invalid signature" }, 401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return json({ error: "Invalid payload" }, 400);
  }

  const event = String(payload?.event || "");
  const data = payload?.data ?? {};
  const supabase = adminClient();

  if (event === "deposit.successful") {
    const quidaxUserId = String(data?.user?.id || data?.wallet?.user?.id || "");
    const asset = String(data?.currency || "").toUpperCase();
    const amount = Number(data?.amount);
    const depositId = String(data?.id || "");
    if (!quidaxUserId || !asset || !Number.isFinite(amount) || amount <= 0 || !depositId) {
      console.error("crypto-quidax-webhook: malformed deposit.successful payload", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }

    const { data: account } = await supabase
      .from("crypto_accounts")
      .select("user_id")
      .eq("quidax_user_id", quidaxUserId)
      .maybeSingle();
    if (!account) {
      console.error(`crypto-quidax-webhook: no KaysPay user for Quidax sub-account ${quidaxUserId}`);
      return json({ received: true });
    }

    const cryptoMicro = Math.round(amount * 1_000_000);
    const { error } = await supabase.rpc("record_crypto_deposit", {
      p_user_id: account.user_id,
      p_asset: asset,
      p_crypto_micro: cryptoMicro,
      p_network: String(data?.network || data?.type || ""),
      p_quidax_deposit_id: depositId,
      p_txid: String(data?.txid || ""),
    });
    if (error) {
      console.error("crypto-quidax-webhook: record_crypto_deposit failed:", error.message);
      return json({ error: "Could not record deposit" }, 500);
    }
    return json({ received: true });
  }

  if (["deposit.on_hold", "deposit_failed_aml", "deposit.rejected"].includes(event)) {
    console.warn(`crypto-quidax-webhook: ${event}`, JSON.stringify(data).slice(0, 500));
    return json({ received: true });
  }

  // Any other event type (buy/sell/withdraw/order events) — not handled
  // until those phases land. Acknowledge so Quidax doesn't keep retrying.
  return json({ received: true });
});
