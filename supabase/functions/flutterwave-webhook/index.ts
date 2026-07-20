import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";

const FLW_WEBHOOK_SECRET = Deno.env.get("FLUTTERWAVE_WEBHOOK_SECRET");

// Confirmed empirically against a real sandbox event (2026-07-04): the
// "flutterwave-signature" header is HMAC-SHA256(rawBody, secret hash),
// base64-encoded. (Flutterwave delivers v4 webhooks via Svix, which also
// attaches its own svix-signature header — that one is NOT this; we only
// configured Flutterwave's own "secret hash" on the dashboard, not a Svix
// signing secret.)
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

  const rawBody = await req.text();
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
    if (event.type === "charge.completed" && event.data?.status === "succeeded") {
      const { id: chargeId, amount, customer } = event.data;
      const customerId = customer?.id;

      if (customerId && chargeId && typeof amount === "number") {
        const { data: va } = await supabase
          .from("virtual_accounts")
          .select("user_id")
          .eq("customer_code", customerId)
          .maybeSingle();

        if (va?.user_id) {
          // Confirmed empirically: Flutterwave reports amount in naira
          // (major units), unlike Paystack's kobo — our ledger is
          // kobo-based, so convert.
          const amountKobo = Math.round(amount * 100);
          await supabase.rpc("credit_wallet_funding", {
            p_user_id: va.user_id,
            p_reference: chargeId,
            p_amount: amountKobo,
            p_source: "flutterwave",
          });
        }
      }
    }

    return new Response(JSON.stringify({ status: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Flutterwave webhook processing error:", (error as Error).message);
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
