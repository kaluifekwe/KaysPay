import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { verifyRampWebhookSignature } from "../_shared/quidax-ramp-client.ts";
import { settleCryptoBuySuccess } from "../_shared/crypto-buy-settle.ts";

// Settles Buy — the only flow that runs on Quidax's RAMP product rather than
// its exchange API. Kept separate from crypto-quidax-webhook because the two
// products are genuinely different integrations: their own dashboards, their
// own webhook URL fields, and — the part that actually bites — completely
// different signature schemes (`x-ramp-signature`, a plain hex HMAC keyed on
// the Ramp secret, vs the exchange's `quidax-signature` t=/s= pair keyed on
// QUIDAX_WEBHOOK_SECRET). These handlers previously sat in the exchange
// webhook, where every Ramp delivery was rejected 401 before reaching them.
//
// Register this function's URL in the Ramp dashboard's "Webhook URL" field.
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

  // Signature covers the body as sent — read it as text before any parsing.
  const rawBody = await req.text();
  const verified = await verifyRampWebhookSignature(rawBody, req.headers.get("x-ramp-signature"));
  if (!verified) {
    console.error("crypto-ramp-webhook: signature verification failed");
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

  // Leg 1 done: the customer's transfer cleared and Quidax delivered USDT
  // into their own sub-account. For a USDT purchase that IS the whole order,
  // and the balance is read live from Quidax, so this only moves the order
  // out of "pending". For any other coin this is the halfway point: it kicks
  // off leg 2, swapping that USDT for the target coin inside the same
  // sub-account — leg 2's own webhook (swap_transaction.complete/.failed,
  // handled in crypto-quidax-webhook) is what actually finishes the order.
  if (event === "buy_transaction.successful") {
    const merchantReference = String(data?.merchant_reference || "");
    const received = Number(data?.crypto_payout?.amount ?? data?.to_amount);
    if (!merchantReference || !Number.isFinite(received) || received <= 0) {
      console.error("crypto-ramp-webhook: unexpected buy_transaction.successful", JSON.stringify(payload).slice(0, 300));
      return json({ received: true });
    }
    await settleCryptoBuySuccess(supabase, {
      merchantReference,
      receivedUsdt: received,
      txHash: data?.crypto_payout?.transaction_hash ? String(data.crypto_payout.transaction_hash) : null,
      logPrefix: "crypto-ramp-webhook",
    });
    return json({ received: true });
  }

  if (event === "buy_transaction.failed") {
    const merchantReference = String(data?.merchant_reference || "");
    if (merchantReference) {
      // Nothing to refund: the money never left the customer's own bank.
      await supabase.rpc("fail_crypto_buy", {
        p_merchant_reference: merchantReference,
        p_reason: String(data?.status || "failed"),
      });
    }
    return json({ received: true });
  }

  // The customer's transfer landed but Quidax hasn't delivered the crypto
  // yet. Records when this happened so completed_at minus this timestamp
  // gives Quidax's own payout time, isolated from however long the customer
  // took to actually send the transfer — otherwise unmeasurable.
  if (event === "buy_transaction.processing") {
    const merchantReference = String(data?.merchant_reference || "");
    if (merchantReference) {
      const { error } = await supabase.rpc("mark_crypto_buy_fiat_received", {
        p_merchant_reference: merchantReference,
      });
      if (error) console.error("crypto-ramp-webhook: mark_crypto_buy_fiat_received failed:", error.message);
    }
    return json({ received: true });
  }

  // Quidax auto-refunds a purchase whose paying bank account name doesn't
  // match the customer (common here — people pay from a spouse's or business
  // account). Flags the order so the app prompts the customer for a bank
  // account to receive it back — see crypto-buy-refund-resolve/-submit.
  // Still alerts, at a lower severity than before: this is now a handled,
  // expected path rather than a dead end, but still worth surfacing so a
  // customer who never opens the app again isn't silently stuck.
  if (event === "buy_transaction.refund.details_requested") {
    const merchantReference = String(data?.merchant_reference || "");
    if (merchantReference) {
      const { error } = await supabase.rpc("mark_crypto_buy_refund_requested", {
        p_merchant_reference: merchantReference,
      });
      if (error) {
        console.error("crypto-ramp-webhook: mark_crypto_buy_refund_requested failed:", error.message);
      }
    }
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `crypto_buy_refund_requested_${merchantReference}`.slice(0, 100).toLowerCase(),
      p_type: "crypto_buy_refund_details_requested",
      p_severity: "warning",
      p_details: { merchant_reference: merchantReference },
    });
    return json({ received: true });
  }

  // Quidax has sent the refund to the bank details we submitted. Nothing to
  // reverse on our side — Buy never debited the KaysPay wallet — so this
  // only needs to move the order out of "pending".
  if (event === "buy_transaction.refund.completed") {
    const merchantReference = String(data?.merchant_reference || "");
    if (merchantReference) {
      await supabase.rpc("fail_crypto_buy", {
        p_merchant_reference: merchantReference,
        p_reason: "refunded_name_mismatch",
      });
    }
    return json({ received: true });
  }

  // Any other event type — acknowledge so Quidax doesn't keep retrying.
  return json({ received: true });
});
