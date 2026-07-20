import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";
import { verifyBvn as verifyBvnPrembly, isPremblyConfigured } from "../_shared/prembly-client.ts";
import { verifyBvn as verifyBvnNinBvn, isNinBvnConfigured } from "../_shared/ninbvn-client.ts";

// Retail price — normally ₦1,000 (confirmed by owner 2026-07-06). TEMPORARILY
// FREE (1 kobo, not a true 0 since debit_for_service requires a strictly
// positive amount) while the owner tests the live flow on their own Kay's
// Pay wallet. Restore to 100000 once the owner confirms testing is done.
const BVN_VERIFY_PRICE_KOBO = 1;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newRequestId(): string {
  return `bvnv${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

interface ProviderOutcome {
  ok: boolean;
  record?: any;
  errorMessage?: string;
}

// Prembly and CheckMyNINBVN use different field names/casing for the same
// BVN record (confirmed against each provider's own docs 2026-07-06:
// Prembly returns firstName/middleName/lastName/dateOfBirth/phoneNumber;
// CheckMyNINBVN returns firstname/middlename/lastname/phone/dob/gender/bvn/
// photo). Normalize both into one shape so the app never needs to know
// which provider actually answered.
function extractBvnRecord(data: any): any {
  const candidates = [data?.data?.data, data?.data, data];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const firstname = c.firstname ?? c.firstName;
    if (typeof firstname === "string" && firstname.trim().length > 0) {
      return {
        firstname,
        middlename: c.middlename ?? c.middleName,
        lastname: c.lastname ?? c.lastName ?? c.surname,
        phone: c.phone ?? c.phoneNumber,
        dob: c.dob ?? c.dateOfBirth,
        gender: c.gender,
        bvn: c.bvn ?? c.number,
        photo: c.photo,
        // Only CheckMyNINBVN's response includes these (confirmed 2026-07-06)
        // — Prembly's bvn_validation doesn't return them, so they're simply
        // absent/undefined when Prembly answers.
        stateOfOrigin: c.state_of_origin,
        stateOfResidence: c.state_of_residence,
      };
    }
  }
  return undefined;
}

// Prembly — PRIMARY (funded account, confirmed 2026-07-06).
async function tryPrembly(bvn: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyBvnPrembly(bvn);
  const record = extractBvnRecord(data);
  const ok = status < 400 && !!record;
  return { ok, record, errorMessage: ok ? undefined : (data?.detail || data?.message || `http_${status}`) };
}

// CheckMyNINBVN — FALLBACK.
async function tryNinBvn(bvn: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyBvnNinBvn(bvn);
  const record = extractBvnRecord(data);
  const ok = status < 400 && !!record;
  return { ok, record, errorMessage: ok ? undefined : (data?.message || `http_${status}`) };
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isPremblyConfigured() && !isNinBvnConfigured()) {
    return json({ error: "BVN verification not configured" }, 500);
  }

  const user = await getAuthUser(req);
  if (!user) return json({ error: "Unauthorized" }, 401);

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid request body" }, 400);
  }

  const bvn = String(body?.bvn || "").trim();
  if (!/^\d{11}$/.test(bvn)) return json({ success: false, error: "Enter a valid 11-digit BVN" }, 400);

  const supabase = adminClient();

  // Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) return json({ success: false, error: "Re-authorization required. Please try again." }, 401);

  const requestId = String(body.idempotency_key || newRequestId());

  // Same 24h cache rationale as nin-verify: a BVN record doesn't change
  // day-to-day, so a repeat lookup shouldn't cost the user twice or risk
  // hitting a provider's rate limit.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: cachedTx } = await supabase
    .from("transactions")
    .select("id, metadata")
    .eq("user_id", user.id)
    .eq("type", "bvn_verification")
    .eq("status", "completed")
    .eq("recipient_phone", bvn)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cachedTx?.metadata?.record?.firstname) {
    return json({
      success: true,
      transaction_id: cachedTx.id,
      record: cachedTx.metadata.record,
      cached: true,
    });
  }

  const { data: txId, error: debitError } = await supabase.rpc("debit_for_service", {
    p_user_id: user.id,
    p_amount: BVN_VERIFY_PRICE_KOBO,
    p_type: "bvn_verification",
    p_network: "N/A",
    p_recipient: bvn,
    p_metadata: { service: "bvn_verification" },
    p_idempotency_key: requestId,
  });

  if (debitError) {
    const msg = debitError.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) return json({ success: false, error: "Insufficient balance" });
    if (msg.includes("WALLET_NOT_FOUND")) return json({ success: false, error: "Wallet not found" });
    return json({ success: false, error: "Could not start transaction" }, 500);
  }

  let outcome: ProviderOutcome = { ok: false };
  let providerUsed = "";
  let lastError: string | undefined;
  let primaryError: string | undefined;

  if (isPremblyConfigured()) {
    try {
      outcome = await tryPrembly(bvn);
      providerUsed = "prembly";
      if (!outcome.ok) {
        primaryError = outcome.errorMessage;
        lastError = outcome.errorMessage;
      }
    } catch (e) {
      primaryError = (e as Error).message;
      lastError = primaryError;
    }
  }

  if (!outcome.ok && isNinBvnConfigured()) {
    try {
      const fallback = await tryNinBvn(bvn);
      if (fallback.ok) {
        outcome = fallback;
        providerUsed = "checkmyninbvn";
      } else {
        lastError = fallback.errorMessage || lastError;
      }
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!outcome.ok) {
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: JSON.stringify({ primary: primaryError, shown: lastError }).slice(0, 500),
    });
    return json({ success: false, error: lastError || "Could not verify this BVN. Please try again." });
  }

  await supabase.rpc("complete_service_transaction", { p_tx_id: txId, p_order_id: bvn });

  await supabase
    .from("transactions")
    .update({ metadata: { service: "bvn_verification", provider: providerUsed, record: outcome.record } })
    .eq("id", txId);

  return json({ success: true, transaction_id: txId, record: outcome.record });
});
