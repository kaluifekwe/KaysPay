import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, enforceRateLimit, getAuthUser } from "../_shared/auth.ts";
import { requeryPaystackDedicatedAccount } from "../_shared/paystack-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

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

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  const supabase = adminClient();
  const rate = await enforceRateLimit(supabase, "paystack_dva_requery", user.id, 1, 600, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Paystack allows this account to be checked once every 10 minutes. Please try again later.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  try {
    const { data: account, error: lookupError } = await supabase
      .from("virtual_accounts")
      .select("account_number, bank_name")
      .eq("user_id", user.id)
      .eq("provider", "paystack")
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (!account?.account_number) {
      return json({ success: false, error: "No Paystack account was found for this wallet." }, 404);
    }

    const result = await requeryPaystackDedicatedAccount(
      String(account.account_number),
      String(account.bank_name || ""),
    );
    if (result.status >= 400 || result.data?.status !== true) {
      console.error("Paystack DVA requery failed:", redactSecrets(JSON.stringify({
        status: result.status,
        message: result.data?.message,
      })));
      return json({
        success: false,
        error: "Paystack could not check this transfer right now. Please try again later.",
      }, result.status >= 500 ? 502 : 400);
    }

    return json({
      success: true,
      message: "Paystack is checking for your transfer. Your wallet will update automatically once it is confirmed.",
    });
  } catch (error) {
    console.error("Paystack DVA requery error:", redactSecrets(error));
    return json({ success: false, error: "We could not check this transfer right now." }, 500);
  }
});
