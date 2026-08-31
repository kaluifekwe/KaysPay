import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { settleCryptoBuySuccess } from "../_shared/crypto-buy-settle.ts";
import { isQuidaxRampConfigured, QuidaxRampError, requeryOnRamp } from "../_shared/quidax-ramp-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

const TERMINAL_FAILURE_STATUSES = new Set(["failed", "needs_attention", "abandoned"]);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);
  if (!isQuidaxRampConfigured()) return json({ success: false, error: "Crypto service unavailable." }, 503);

  let body: { transaction_id?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const transactionId = String(body.transaction_id || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(transactionId)) {
    return json({ success: false, error: "Invalid transaction." }, 400);
  }

  const supabase = adminClient();
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ error: "This device session has been revoked. Please log in again." }, 401);
  }

  // Called only every third client status check. Keep a strict server-side
  // limit as the real protection against modified clients hammering Quidax.
  const rate = await enforceRateLimit(supabase, "crypto_buy_status_refresh", user.id, 30, 300, user.id);
  if (!rate.allowed) {
    return json({ success: false, pending: true, retry_after_seconds: rate.retryAfterSeconds }, 429);
  }

  const { data: tx, error: txError } = await supabase
    .from("transactions")
    .select("id, status, metadata")
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .eq("type", "crypto_buy")
    .maybeSingle();

  if (txError || !tx) return json({ success: false, error: "Transaction not found." }, 404);
  if (tx.status !== "pending" || tx.metadata?.needs_refund_bank_details === true) {
    return json({ success: true, status: tx.status, metadata: tx.metadata });
  }

  const merchantReference = String(tx.metadata?.quidax_merchant_reference || "");
  const candidates = Array.from(new Set([
    String(tx.metadata?.quidax_reference || ""),
    merchantReference,
  ].filter(Boolean)));

  let remote: Awaited<ReturnType<typeof requeryOnRamp>> | null = null;
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      remote = await requeryOnRamp(candidate);
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      if (!(error instanceof QuidaxRampError) || error.status !== 404) break;
    }
  }

  if (remote?.status === "completed" && remote.cryptoAmount != null && remote.cryptoAmount > 0) {
    await settleCryptoBuySuccess(supabase, {
      merchantReference,
      receivedUsdt: remote.cryptoAmount,
      txHash: remote.txHash,
      logPrefix: "crypto-buy-status-refresh",
    });
  } else if (remote && TERMINAL_FAILURE_STATUSES.has(remote.status)) {
    await supabase.rpc("fail_crypto_buy", {
      p_merchant_reference: merchantReference,
      p_reason: remote.errorMessage || `status_refresh_${remote.status}`,
    });
  } else if (lastError && !(lastError instanceof QuidaxRampError && lastError.status === 404)) {
    console.error("crypto-buy-status-refresh: provider requery failed:", redactSecrets(lastError));
  }

  const { data: refreshed } = await supabase
    .from("transactions")
    .select("status, metadata")
    .eq("id", transactionId)
    .eq("user_id", user.id)
    .maybeSingle();

  return json({
    success: true,
    status: refreshed?.status || tx.status,
    metadata: refreshed?.metadata || tx.metadata,
  });
});
