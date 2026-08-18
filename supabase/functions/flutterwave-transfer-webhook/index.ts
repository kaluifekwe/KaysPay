import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";

// Settles Transfer's actual outcome — Flutterwave's /direct-transfers call
// only ever confirms "accepted", never "settled" (see transfer-send), so
// this webhook is the only place a transfer transaction actually completes.
// Separate function from flutterwave-webhook (which handles funding-side
// charge.completed events only) — matches this codebase's one-function-
// per-feature webhook convention (crypto-quidax-webhook is likewise its
// own function, distinct from the funding webhooks).
const FLW_WEBHOOK_SECRET = Deno.env.get("FLUTTERWAVE_WEBHOOK_SECRET");

// Identical HMAC verification to flutterwave-webhook/index.ts — same
// "flutterwave-signature" header, same secret, confirmed empirically there.
async function isValidSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature || !FLW_WEBHOOK_SECRET) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(FLW_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const macBase64 = btoa(String.fromCharCode(...new Uint8Array(mac)));

  if (macBase64.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < macBase64.length; i++) diff |= macBase64.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 131_072) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 131_072) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }
  const valid = await isValidSignature(rawBody, req.headers.get("flutterwave-signature"));
  if (!valid) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400 });
  }

  const supabase = adminClient();

  try {
    if (event.type === "transfer.disburse" || event.type === "transfer.reversal") {
      const reference = String(event.data?.reference || "");
      const providerTransferId = String(event.data?.id || "");
      const status = String(event.data?.status || "").toUpperCase();
      if (!reference) {
        return new Response(JSON.stringify({ error: "Missing reference" }), { status: 400 });
      }

      const { data: tx } = await supabase
        .from("transactions")
        .select("id, status, type")
        .eq("metadata->>idempotency_key", reference)
        .maybeSingle();

      // Not our transfer (or already an unrelated tx) — acknowledge and
      // move on rather than erroring, same as flutterwave-webhook does for
      // payment types it doesn't handle.
      if (!tx || tx.type !== "transfer") {
        return new Response(JSON.stringify({ status: true }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      if (event.type === "transfer.disburse" && status === "SUCCESSFUL") {
        const { error } = await supabase.rpc("complete_service_transaction", {
          p_tx_id: tx.id,
          p_order_id: providerTransferId,
        });
        if (error) throw error;
      } else {
        // transfer.reversal, or a disburse that settled as FAILED/anything
        // other than SUCCESSFUL — refund. Whether the tx already flipped to
        // 'completed' (a reversal arriving after an earlier disburse event)
        // or is still 'pending' decides which refund RPC applies; both are
        // idempotent and safe to call regardless of exact prior state.
        await confirmServiceRefund(
          supabase,
          tx.id,
          `flutterwave_${event.type}_${status || "unknown"}`,
          "webhook",
          tx.status === "completed",
        );
      }
    }

    return new Response(JSON.stringify({ status: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Flutterwave transfer webhook processing error:", redactSecrets(error));
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
