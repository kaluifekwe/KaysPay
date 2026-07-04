import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";

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
    const requestId = event.request_id;
    const status = event.status;

    if (!requestId) {
      return new Response(JSON.stringify({ status: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Our own idempotency_key IS the request_id we sent VTU.ng — find the
    // matching transaction (still 'pending' if this webhook is the first
    // thing to resolve it; the RPCs below are safe no-ops if it already
    // settled via requery in the original request).
    const { data: tx } = await supabase
      .from("transactions")
      .select("id")
      .eq("metadata->>idempotency_key", requestId)
      .maybeSingle();

    if (tx?.id) {
      if (status === "completed-api") {
        await supabase.rpc("complete_service_transaction", {
          p_tx_id: tx.id,
          p_order_id: event.order_id ?? null,
        });
      } else {
        // "Order Refunded" and any other terminal-failure notification.
        await supabase.rpc("refund_service_transaction", {
          p_tx_id: tx.id,
          p_reason: status || "webhook_refund",
        });
      }
    }

    return new Response(JSON.stringify({ status: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("VTU.ng webhook processing error:", (error as Error).message);
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
