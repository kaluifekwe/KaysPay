import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";

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

    // Identify the funder from the JWT, not the body.
    const user = await getAuthUser(req);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { email, amount, reference, callback_url } = await req.json();

    if (!email || !amount || !reference) {
      return json({ error: "Missing required fields: email, amount, reference" }, 400);
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      return json({ error: "Invalid amount" }, 400);
    }

    const response = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount, // in kobo (amount * 100)
        reference,
        channels: ["card", "bank", "ussd", "bank_transfer"],
        callback_url: callback_url || undefined,
        // user_id is the trusted owner; verify/webhook read it back to credit.
        metadata: {
          user_id: user.id,
          custom_fields: [
            { display_name: "Platform", variable_name: "platform", value: "kayspay_mobile" },
          ],
        },
      }),
    });

    const data = await response.json();

    if (!data.status) {
      return json({ error: data.message || "Failed to initialize transaction" }, 400);
    }

    return json({
      status: true,
      authorization_url: data.data.authorization_url,
      access_code: data.data.access_code,
      reference: data.data.reference,
    });
  } catch (error) {
    return json({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
