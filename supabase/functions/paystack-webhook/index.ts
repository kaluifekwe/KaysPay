import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");

// Paystack signs the raw body with HMAC-SHA512 using your secret key.
// We verify it properly using Web Crypto and a constant-time compare.
async function verifySignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!signature || !PAYSTACK_SECRET) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PAYSTACK_SECRET),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));

  const expected = Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  // Constant-time comparison.
  if (expected.length !== signature.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  return diff === 0;
}

serve(async (req: Request) => {
  // Webhooks are server-to-server: no CORS preflight, POST only.
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const valid = await verifySignature(rawBody, req.headers.get("x-paystack-signature"));
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
    switch (event.event) {
      case "charge.success": {
        // Funding via card (metadata.user_id) OR dedicated virtual account
        // (resolve the user from the Paystack customer). Idempotent on reference.
        const { reference, amount, metadata, customer } = event.data;
        let userId = metadata?.user_id;

        if (!userId && customer?.customer_code) {
          const { data: va } = await supabase
            .from("virtual_accounts")
            .select("user_id")
            .eq("customer_code", customer.customer_code)
            .maybeSingle();
          userId = va?.user_id;
        }

        if (userId) {
          await supabase.rpc("credit_wallet_funding", {
            p_user_id: userId,
            p_reference: reference,
            p_amount: amount, // Paystack amount is already in kobo
          });
        }
        break;
      }

      case "transfer.success": {
        await supabase.rpc("complete_withdrawal_by_reference", {
          p_reference: event.data.reference,
        });
        break;
      }

      case "transfer.failed": {
        await supabase.rpc("refund_withdrawal_by_reference", {
          p_reference: event.data.reference,
          p_reason: event.data.reason || "transfer_failed",
        });
        break;
      }

      case "transfer.reversed": {
        await supabase.rpc("refund_withdrawal_by_reference", {
          p_reference: event.data.reference,
          p_reason: "transfer_reversed",
        });
        break;
      }

      default:
        // Acknowledge unhandled events so Paystack stops retrying.
        break;
    }

    return new Response(JSON.stringify({ status: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Webhook processing error:", (error as Error).message);
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
