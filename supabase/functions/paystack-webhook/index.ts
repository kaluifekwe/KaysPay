import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { redactSecrets } from "../_shared/redact.ts";
import { processFundingCandidate } from "../_shared/funding-credit.ts";
import { confirmServiceRefund } from "../_shared/service-refund.ts";

const PAYSTACK_SECRET_KEY = Deno.env.get("PAYSTACK_SECRET_KEY")?.trim();

async function isValidSignature(rawBody: string, signature: string | null): Promise<boolean> {
  if (!PAYSTACK_SECRET_KEY || !signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PAYSTACK_SECRET_KEY),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (expected.length !== signature.length) return false;
  let difference = 0;
  for (let i = 0; i < expected.length; i++) {
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return difference === 0;
}

serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const declaredLength = Number(req.headers.get("content-length") || 0);
  if (Number.isFinite(declaredLength) && declaredLength > 131_072) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }
  const rawBody = await req.text();
  if (new TextEncoder().encode(rawBody).byteLength > 131_072) {
    return new Response(JSON.stringify({ error: "Payload too large" }), { status: 413 });
  }
  if (!(await isValidSignature(rawBody, req.headers.get("x-paystack-signature")))) {
    return new Response(JSON.stringify({ error: "Invalid signature" }), { status: 401 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response(JSON.stringify({ error: "Invalid payload" }), { status: 400 });
  }

  try {
    if (event.event === "dedicatedaccount.assign.success") {
      const supabase = adminClient();
      const data = event.data;
      const account = data?.dedicated_account || data;
      const customerCode = data?.customer?.customer_code || data?.customer_code;
      if (customerCode && account?.account_number) {
        const { error: updateError } = await supabase
          .from("virtual_accounts")
          .update({
            account_number: String(account.account_number),
            bank_name: String(account.bank?.name || account.bank_name || "Paystack"),
            account_name: String(account.account_name || "Paystack Account"),
            dva_id: String(account.id ?? ""),
          })
          .eq("provider", "paystack")
          .eq("customer_code", String(customerCode));
        if (updateError) throw updateError;
      }
    }

    if (event.event === "charge.success") {
      const data = event.data;
      const authorization = data?.authorization;
      const receiverAccount = authorization?.receiver_bank_account_number;
      const amountKobo = data?.amount;
      const reference = data?.reference;

      // This endpoint credits only transfers into Paystack Dedicated NUBANs.
      // Card, checkout and other Paystack payment channels remain untouched.
      if (authorization?.channel !== "dedicated_nuban") {
        return new Response(JSON.stringify({ status: true }), { headers: { "Content-Type": "application/json" } });
      }
      if (
        !receiverAccount || !reference || !Number.isSafeInteger(amountKobo) || amountKobo <= 0 ||
        (data?.currency && data.currency !== "NGN")
      ) {
        return new Response(JSON.stringify({ error: "Invalid DVA charge payload" }), { status: 400 });
      }

      const supabase = adminClient();
      const credit = await processFundingCandidate(supabase, {
        provider: "paystack",
        reference: String(reference),
        transactionId: data?.id != null ? String(data.id) : null,
        amountKobo,
        currency: String(data?.currency || "NGN"),
        accountNumber: String(receiverAccount),
        customerCode: data?.customer?.customer_code ? String(data.customer.customer_code) : null,
        providerCreatedAt: data?.paid_at || data?.created_at || null,
        source: "webhook",
      });
      if (credit.outcome === "unmatched" || credit.outcome === "rejected") {
        throw new Error(`PAYSTACK_FUNDING_${credit.outcome.toUpperCase()}`);
      }
    }

    // Transfer settlement — only ever reached via the Paystack FALLBACK path
    // in transfer-send (Flutterwave rejected first, Paystack accepted).
    // /transfer only ever confirms "accepted" synchronously — this is where
    // that class of transfer actually completes. Matched on `reference`,
    // the same idempotency key sent to both providers.
    if (event.event === "transfer.success" || event.event === "transfer.failed" || event.event === "transfer.reversed") {
      const reference = String(event.data?.reference || "");
      const transferId = event.data?.id != null ? String(event.data.id) : null;

      if (reference) {
        const supabase = adminClient();
        const { data: tx } = await supabase
          .from("transactions")
          .select("id, status, type")
          .eq("metadata->>idempotency_key", reference)
          .maybeSingle();

        if (tx && tx.type === "transfer") {
          if (event.event === "transfer.success") {
            const { error } = await supabase.rpc("complete_service_transaction", {
              p_tx_id: tx.id,
              p_order_id: transferId,
            });
            if (error) throw error;
          } else {
            await confirmServiceRefund(
              supabase,
              tx.id,
              `paystack_${event.event}`,
              "webhook",
              tx.status === "completed",
            );
          }
        }
      }
    }

    return new Response(JSON.stringify({ status: true }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Paystack webhook processing error:", redactSecrets(error));
    return new Response(JSON.stringify({ error: "Processing error" }), { status: 500 });
  }
});
