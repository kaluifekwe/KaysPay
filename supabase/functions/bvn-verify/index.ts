import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";
import { verifyBvnFull as verifyBvnPremblyFull, isPremblyConfigured } from "../_shared/prembly-client.ts";
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
  // Provider reached and answered cleanly but has no record for this number —
  // a definitive miss, not an outage. Callers skip the fallback on this.
  notFound?: boolean;
}

// Providers use different field names/casing for the same BVN record. Prembly
// BVN 2.0 returns camelCase (enrollmentBank, lgaOfResidence, base64Image, …),
// usually nested under bvn_data; the older endpoints and CheckMyNINBVN use
// snake_case (state_of_origin, …). Normalize every plausible spelling into one
// shape so the app (and the slip) never needs to know which provider/endpoint
// answered. Fields the answering endpoint doesn't return stay undefined.
function pick(c: any, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = c[k];
    if (v !== undefined && v !== null && v !== "") return typeof v === "string" ? v : String(v);
  }
  return undefined;
}

function extractBvnRecord(data: any): any {
  const candidates = [data?.bvn_data, data?.data?.bvn_data, data?.data?.data, data?.data, data];
  for (const c of candidates) {
    if (!c || typeof c !== "object") continue;
    const firstname = pick(c, "firstname", "firstName", "first_name");
    if (typeof firstname === "string" && firstname.trim().length > 0) {
      return {
        firstname,
        middlename: pick(c, "middlename", "middleName", "middle_name"),
        lastname: pick(c, "lastname", "lastName", "surname"),
        phone: pick(c, "phone", "phoneNumber1", "phoneNumber", "phone_number"),
        dob: pick(c, "dob", "dateOfBirth", "DateOfBirth", "birthdate"),
        gender: pick(c, "gender"),
        bvn: pick(c, "bvn", "number"),
        photo: pick(c, "photo", "base64Image", "image", "face_image"),
        maritalStatus: pick(c, "maritalStatus", "marital_status"),
        nationality: pick(c, "nationality"),
        stateOfOrigin: pick(c, "stateOfOrigin", "state_of_origin"),
        stateOfResidence: pick(c, "stateOfResidence", "state_of_residence"),
        lgaOfOrigin: pick(c, "lgaOfOrigin", "lga_of_origin"),
        lgaOfResidence: pick(c, "lgaOfResidence", "lga_of_residence"),
        residentialAddress: pick(c, "residentialAddress", "residential_address", "address"),
        enrollmentBank: pick(c, "enrollmentBank", "enrollment_bank", "registrationBank"),
        enrollmentBranch: pick(c, "enrollmentBranch", "enrollment_branch"),
        nameOnCard: pick(c, "nameOnCard", "name_on_card"),
      };
    }
  }
  return undefined;
}

// Prembly — PRIMARY (funded account, confirmed 2026-07-06).
async function tryPrembly(bvn: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyBvnPremblyFull(bvn);
  const record = extractBvnRecord(data);
  const ok = status < 400 && !!record;
  // 2xx + no record = the BVN genuinely isn't on file (definitive miss).
  const notFound = status >= 200 && status < 300 && !record;
  return { ok, record, notFound, errorMessage: ok ? undefined : (data?.detail || data?.message || `http_${status}`) };
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
        lastError = outcome.notFound
          ? "No record found for this BVN. Please check the number and try again."
          : outcome.errorMessage;
      }
    } catch (e) {
      primaryError = (e as Error).message;
      lastError = primaryError;
    }
  }

  // Fall back ONLY on a real provider failure — not on a definitive "not
  // found", so an invalid BVN doesn't cost a second lookup.
  if (!outcome.ok && !outcome.notFound && isNinBvnConfigured()) {
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
