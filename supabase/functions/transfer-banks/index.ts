import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, enforceRateLimit } from "../_shared/auth.ts";
import { isFlutterwaveConfigured, listFlutterwaveBanks } from "../_shared/flutterwave-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

// Bank list for the Transfer bank picker. Phase 1 is Flutterwave-only —
// Paystack's bank list joins once Paystack is wired in as the second rail.
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  if (!isFlutterwaveConfigured()) {
    return json({ success: false, error: "Transfers aren't available yet." }, 503);
  }

  const rate = await enforceRateLimit(adminClient(), "transfer_banks", user.id, 20, 60, user.id);
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Please wait a moment and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  try {
    const supabase = adminClient();
    const res = await listFlutterwaveBanks(supabase);
    if (res.status >= 400 || res.data?.status !== "success") {
      console.error("transfer-banks: Flutterwave bank list failed:", redactSecrets(JSON.stringify({ status: res.status, message: res.data?.message })));
      return json({ success: false, error: "Could not load the bank list. Please try again." }, 502);
    }
    const banks = (res.data.data ?? [])
      .map((b: any) => ({ code: String(b.code ?? ""), name: String(b.name ?? "") }))
      .filter((b: { code: string; name: string }) => b.code && b.name)
      .sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name));
    return json({ success: true, banks });
  } catch (e) {
    console.error("transfer-banks unhandled error:", redactSecrets(e));
    return json({ success: false, error: "Could not load the bank list. Please try again." }, 500);
  }
});
