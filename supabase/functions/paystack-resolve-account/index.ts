import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser } from "../_shared/auth.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");

serve(async (req: Request) => {
  const corsResponse = handleCors(req);
  if (corsResponse) return corsResponse;

  try {
    if (!PAYSTACK_SECRET) {
      return new Response(
        JSON.stringify({ error: "Paystack secret key not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Account-name lookups reveal a real person's name for any account
    // number — require a logged-in caller so this can't be used as an
    // open, unauthenticated name-resolution oracle.
    const user = await getAuthUser(req);
    if (!user) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { account_number, bank_code } = await req.json();

    if (!account_number || !bank_code) {
      return new Response(
        JSON.stringify({ error: "Missing required fields: account_number, bank_code" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate account number format (10 digits for NUBAN)
    if (!/^\d{10}$/.test(account_number)) {
      return new Response(
        JSON.stringify({ error: "Account number must be 10 digits" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const url = `https://api.paystack.co/bank/resolve?account_number=${account_number}&bank_code=${bank_code}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET}`,
        "Content-Type": "application/json",
      },
    });

    const data = await response.json();

    if (!data.status) {
      return new Response(
        JSON.stringify({ error: data.message || "Account resolution failed", status: false }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        status: true,
        data: {
          account_name: data.data.account_name,
          account_number: data.data.account_number,
          bank_code: bank_code,
        },
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message || "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
