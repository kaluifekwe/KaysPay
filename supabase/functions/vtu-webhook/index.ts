import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { redactSecrets } from "../_shared/redact.ts";

// VTU.ng's own account PIN (NOT the login password) — used only to verify
// webhook signatures. Set via: supabase secrets set VTU_NG_USER_PIN=xxx
const VTU_NG_USER_PIN = Deno.env.get("VTU_NG_USER_PIN");

// VTU.ng signs the raw webhook body with HMAC-SHA256 using your account's
// user_pin. Verify properly using Web Crypto + a constant-time compare —
// same pattern as paystack-webhook, just SHA-256 instead of SHA-512.
async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature || !VTU_NG_USER_PIN) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(VTU_NG_USER_PIN),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));

  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const valid = await verifySignature(rawBody, req.headers.get("x-signature"));
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
    const requestId = typeof event.request_id === "string" ? event.request_id.trim() : "";
    const status = typeof event.status === "string" ? event.status.trim().toLowerCase() : "";

    if (!requestId) {
      return new Response(JSON.stringify({ error: "Missing request_id" }), { status: 400 });
    }

    // Our own idempotency_key IS the request_id we sent VTU.ng — find the
    // matching transaction (still 'pending' if this webhook is the first
    // thing to resolve it; the RPCs below are safe no-ops if it already
    // settled via requery in the original request).
    const { data: tx, error: lookupError } = await supabase
      .from("transactions")
      .select("id")
      .eq("metadata->>idempotency_key", requestId)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!tx?.id) throw new Error("No transaction for VTU.ng webhook request");

    if (status === "completed-api") {
      const { error: completionError } = await supabase.rpc("complete_service_transaction", {
        p_tx_id: tx.id,
        p_order_id: event.order_id ?? null,
      });
      if (completionError) throw completionError;
    } else if (["order refunded", "refunded", "refunded-api", "failed", "failed-api", "cancelled", "cancelled-api"].includes(status)) {
      const { error: refundError } = await supabase.rpc("refund_service_transaction", {
        p_tx_id: tx.id,
        p_reason: status,
      });
      if (refundError) throw refundError;
    }

    return new Response(JSON.stringify({ status: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("VTU.ng webhook processing error:", redactSecrets(error));
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
