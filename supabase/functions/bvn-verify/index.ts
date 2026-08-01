import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  isServiceEnabled,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import {
  isPremblyConfigured,
  verifyBvnFull as verifyBvnPremblyFull,
} from "../_shared/prembly-client.ts";
import {
  isNinBvnConfigured,
  verifyBvn as verifyBvnNinBvn,
} from "../_shared/ninbvn-client.ts";

// BVN slip prices (owner-set 2026-07-26): Regular Slip ₦500, Card ₦700.
// SERVER-AUTHORITATIVE — the client sends the chosen slip type, but the price
// is looked up HERE; a tampered client amount can never change what is charged.
// Kobo, since debit_for_service charges in kobo.
const SLIP_PRICE_KOBO: Record<string, number> = { regular: 50000, card: 70000 };
const DEFAULT_SLIP_TIER = "regular";

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
    if (v !== undefined && v !== null && v !== "") {
      return typeof v === "string" ? v : String(v);
    }
  }
  return undefined;
}

function extractBvnRecord(data: any): any {
  const candidates = [
    data?.bvn_data,
    data?.data?.bvn_data,
    data?.data?.data,
    data?.data,
    data,
  ];
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
        residentialAddress: pick(
          c,
          "residentialAddress",
          "residential_address",
          "address",
        ),
        enrollmentBank: pick(
          c,
          "enrollmentBank",
          "enrollment_bank",
          "registrationBank",
        ),
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
  return {
    ok,
    record,
    notFound,
    errorMessage: ok
      ? undefined
      : (data?.detail || data?.message || `http_${status}`),
  };
}

// CheckMyNINBVN — FALLBACK.
async function tryNinBvn(bvn: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyBvnNinBvn(bvn);
  const record = extractBvnRecord(data);
  const ok = status < 400 && !!record;
  return {
    ok,
    record,
    errorMessage: ok ? undefined : (data?.message || `http_${status}`),
  };
}

console.info("[build] phase5-financial-controls-20260801");

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
    body = await readJsonBody(req);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  const bvn = String(body?.bvn || "").trim();
  if (!/^\d{11}$/.test(bvn)) {
    return json({ success: false, error: "Enter a valid 11-digit BVN" }, 400);
  }

  const supabase = adminClient();
  if (!(await isServiceEnabled(supabase, "identity"))) {
    return json({
      success: false,
      error:
        "Identity services are temporarily unavailable. Please try again later.",
    }, 503);
  }
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "bvn_verify",
    user.id,
    6,
    3600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many BVN verification attempts. Please wait and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  // Require server-verified proof the PIN/biometric step-up just ran for
  // THIS request — a valid JWT alone is not enough to move money.
  const authorized = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authorized) {
    return json({
      success: false,
      error: "Re-authorization required. Please try again.",
    }, 401);
  }

  const requestId = String(body.idempotency_key || newRequestId());

  // The slip type chosen up front decides the price. Validate against our own
  // map — never trust a client-sent amount.
  const slipTier = Object.prototype.hasOwnProperty.call(
      SLIP_PRICE_KOBO,
      String(body?.slip_tier),
    )
    ? String(body.slip_tier)
    : DEFAULT_SLIP_TIER;
  const priceKobo = SLIP_PRICE_KOBO[slipTier];

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
    const cachedTier = cachedTx.metadata.slip_tier || DEFAULT_SLIP_TIER;
    // Same BVN + same slip type within 24h → free re-access (re-download).
    if (cachedTier === slipTier) {
      return json({
        success: true,
        transaction_id: cachedTx.id,
        record: cachedTx.metadata.record,
        cached: true,
      });
    }
    // Different slip type (e.g. upgrading Regular → Card): reuse the already
    // verified record (no provider re-call), but charge the new type's price.
    const { data: upTxId, error: upErr } = await supabase.rpc(
      "debit_for_service",
      {
        p_user_id: user.id,
        p_amount: priceKobo,
        p_type: "bvn_verification",
        p_network: "N/A",
        p_recipient: bvn,
        p_metadata: { service: "bvn_verification", slip_tier: slipTier },
        p_idempotency_key: requestId,
      },
    );
    if (upErr) {
      const msg = upErr.message || "";
      if (msg.includes("INSUFFICIENT_FUNDS")) {
        return json({ success: false, error: "Insufficient balance" });
      }
      if (msg.includes("WALLET_NOT_FOUND")) {
        return json({ success: false, error: "Wallet not found" });
      }
      return json(
        { success: false, error: "Could not start transaction" },
        500,
      );
    }
    await supabase.rpc("complete_service_transaction", {
      p_tx_id: upTxId,
      p_order_id: bvn,
    });
    await supabase
      .from("transactions")
      .update({
        metadata: {
          service: "bvn_verification",
          slip_tier: slipTier,
          provider: "cache",
          record: cachedTx.metadata.record,
        },
      })
      .eq("id", upTxId);
    return json({
      success: true,
      transaction_id: upTxId,
      record: cachedTx.metadata.record,
      cached: true,
    });
  }

  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: priceKobo,
      p_type: "bvn_verification",
      p_network: "N/A",
      p_recipient: bvn,
      p_metadata: { service: "bvn_verification", slip_tier: slipTier },
      p_idempotency_key: requestId,
    },
  );

  if (debitError) {
    const msg = debitError.message || "";
    if (msg.includes("INSUFFICIENT_FUNDS")) {
      return json({ success: false, error: "Insufficient balance" });
    }
    if (msg.includes("WALLET_NOT_FOUND")) {
      return json({ success: false, error: "Wallet not found" });
    }
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
      p_reason: JSON.stringify({ primary: primaryError, shown: lastError })
        .slice(0, 500),
    });
    return json({
      success: false,
      error: lastError || "Could not verify this BVN. Please try again.",
    });
  }

  await supabase.rpc("complete_service_transaction", {
    p_tx_id: txId,
    p_order_id: bvn,
  });

  await supabase
    .from("transactions")
    .update({
      metadata: {
        service: "bvn_verification",
        slip_tier: slipTier,
        provider: providerUsed,
        record: outcome.record,
      },
    })
    .eq("id", txId);

  return json({ success: true, transaction_id: txId, record: outcome.record });
});
