import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { confirmSwapQuotation, createSwapQuotation } from "../_shared/quidax-client.ts";
import { verifyRampWebhookSignature } from "../_shared/quidax-ramp-client.ts";
import { findSwapAsset } from "../_shared/crypto-assets.ts";

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

    const { data: order } = await supabase
      .from("transactions")
      .select("id, user_id, status, metadata")
      .eq("type", "crypto_buy")
      .eq("metadata->>quidax_merchant_reference", merchantReference)
      .maybeSingle();
    if (!order) {
      console.warn(`crypto-ramp-webhook: no pending buy for ${merchantReference}`);
      return json({ received: true });
    }

    const targetAsset = String(order.metadata?.asset || "USDT").toUpperCase();
    const swapAsset = targetAsset === "USDT" ? null : findSwapAsset(targetAsset);

    if (!swapAsset) {
      const { error } = await supabase.rpc("complete_crypto_buy", {
        p_merchant_reference: merchantReference,
        p_crypto_micro: Math.round(received * 1_000_000),
        p_tx_hash: data?.crypto_payout?.transaction_hash
          ? String(data.crypto_payout.transaction_hash)
          : null,
      });
      if (error) {
        console.error("crypto-ramp-webhook: complete_crypto_buy failed:", error.message);
        return json({ error: "Could not settle purchase" }, 500);
      }
      return json({ received: true });
    }

    if (order.status !== "pending") {
      // Already advanced past leg 1 by an earlier delivery of this webhook.
      return json({ received: true });
    }

    try {
      const { data: account } = await supabase
        .from("crypto_accounts")
        .select("quidax_user_id")
        .eq("user_id", order.user_id)
        .maybeSingle();
      if (!account) {
        console.error(`crypto-ramp-webhook: no crypto account for user ${order.user_id}, cannot start buy swap`);
        return json({ received: true });
      }

      const quotation = await createSwapQuotation({
        quidaxUserId: account.quidax_user_id,
        fromCurrency: "usdt",
        toCurrency: swapAsset.quidaxCode,
        fromAmount: String(received),
      });

      await supabase.rpc("record_crypto_buy_swap_pending", {
        p_merchant_reference: merchantReference,
        p_usdt_micro: Math.round(received * 1_000_000),
        p_swap_id: quotation.id,
      });

      try {
        await confirmSwapQuotation({ quidaxUserId: account.quidax_user_id, quotationId: quotation.id });
      } catch (confirmError) {
        const detail = confirmError instanceof Error ? confirmError.message : String(confirmError);
        console.error("crypto-ramp-webhook: buy swap confirm failed:", detail);
        await supabase.rpc("fail_crypto_buy_swap", { p_swap_id: quotation.id, p_reason: "confirm_failed" });
      }
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      console.error("crypto-ramp-webhook: could not start buy swap leg:", detail);
      // Leg 1's USDT is safely in the customer's own sub-account regardless
      // — flagged for follow-up rather than silently stuck 'pending' forever.
      await supabase.rpc("record_monitoring_alert", {
        p_fingerprint: `crypto_buy_swap_start_failed_${merchantReference}`.slice(0, 100).toLowerCase(),
        p_type: "crypto_buy_swap_start_failed",
        p_severity: "warning",
        p_details: { merchant_reference: merchantReference, target_asset: targetAsset, error: detail.slice(0, 300) },
      });
    }
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
  // yet — the order is already 'pending' here, so there is nothing to change.
  if (event === "buy_transaction.processing") {
    return json({ received: true });
  }

  // Quidax auto-refunds a purchase whose paying bank account name doesn't
  // match the customer (common here — people pay from a spouse's or business
  // account). Answering it needs the customer's own bank details submitted
  // back to Ramp, which is a separate piece of work; log loudly and alert so
  // no refund sits silently unanswered in the meantime.
  if (event === "buy_transaction.refund.details_requested") {
    const merchantReference = String(data?.merchant_reference || "");
    console.error(`crypto-ramp-webhook: refund details requested for ${merchantReference} — not yet automated`);
    await supabase.rpc("record_monitoring_alert", {
      p_fingerprint: `crypto_buy_refund_requested_${merchantReference}`.slice(0, 100).toLowerCase(),
      p_type: "crypto_buy_refund_details_requested",
      p_severity: "critical",
      p_details: { merchant_reference: merchantReference },
    });
    return json({ received: true });
  }

  // Any other event type — acknowledge so Quidax doesn't keep retrying.
  return json({ received: true });
});
