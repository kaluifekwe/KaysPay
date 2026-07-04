import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (!PAYSTACK_SECRET) return json({ error: "Paystack secret key not configured" }, 500);

    const user = await getAuthUser(req);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { reference } = await req.json();
    if (!reference) return json({ error: "Missing required field: reference" }, 400);

    // 1. Ask Paystack for the source-of-truth result.
    const response = await fetch(`https://api.paystack.co/transaction/verify/${reference}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
    });
    const data = await response.json();

    if (!data.status) {
      return json({ status: false, error: data.message || "Verification failed" }, 400);
    }

    const tx = data.data;
    const amountKobo = tx.amount; // Paystack amounts are already in kobo
    const ownerId = tx.metadata?.user_id;

    // 2. Only the original funder may settle their own payment. A reference
    // with no owner metadata (e.g. a Dedicated Virtual Account bank transfer)
    // is NOT this caller's to claim — those are only ever credited by the
    // signed webhook, which resolves the true owner via customer_code.
    if (ownerId !== user.id) {
      return json({ status: false, error: "Reference does not belong to this user" }, 403);
    }

    // 3. Credit only on a genuinely successful charge, idempotently.
    if (tx.status === "success") {
      const supabase = adminClient();
      const { data: creditResult, error: creditError } = await supabase.rpc("credit_wallet_funding", {
        p_user_id: user.id,
        p_reference: tx.reference,
        p_amount: amountKobo,
      });

      if (creditError) {
        console.error("credit_wallet_funding failed:", creditError.message, creditError.code);
        return json(
          { status: false, error: "We received your payment; your wallet will be credited shortly." },
          500,
        );
      }

      // Amount + balance returned in kobo; the client service converts to naira.
      return json({
        status: true,
        data: {
          reference: tx.reference,
          amount: amountKobo,
          status: tx.status,
          credited: (creditResult as any)?.credited ?? false,
          balance: (creditResult as any)?.balance ?? null,
        },
      });
    }

    return json({
      status: true,
      data: { reference: tx.reference, amount: amountKobo, status: tx.status, credited: false },
    });
  } catch (error) {
    return json({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
