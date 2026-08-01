import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import {
  isPremblyConfigured,
  verifyNin as verifyNinPrembly,
} from "../_shared/prembly-client.ts";
import {
  isNinBvnConfigured,
  verifyNin as verifyNinBvn,
} from "../_shared/ninbvn-client.ts";

// Retail prices confirmed by owner 2026-07-26: Regular Slip ₦500, Card ₦700.
// SERVER-AUTHORITATIVE: the client sends the chosen slip type, but the price
// is looked up HERE — a tampered client amount can never change what is
// charged. Kobo, since debit_for_service requires a strictly positive amount.
const SLIP_PRICE_KOBO: Record<string, number> = { regular: 50000, card: 70000 };
const DEFAULT_SLIP_TIER = "regular";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function newRequestId(): string {
  return `ninv${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
}

// Both providers return the same field names (confirmed against each of
// their own docs 2026-07-05), so a single normalizer covers either.
function normalizeDob(v: unknown): string {
  const s = String(v ?? "").trim();
  const dmy = s.match(/^(\d{2})-(\d{2})-(\d{4})$/); // Prembly's DD-MM-YYYY
  if (dmy) return `${dmy[3]}-${dmy[2]}-${dmy[1]}`;
  return s; // already YYYY-MM-DD (CheckMyNINBVN's format, or unrecognized)
}

function normalizeGender(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().slice(0, 1);
}

// Compares the provider's on-file record against whatever the caller
// claims, field by field — used by banks/schools/agents to confirm
// submitted details are genuine, per the "verification" use case.
function buildMatchReport(
  record: any,
  claimed: Record<string, string> | undefined,
) {
  if (!claimed) return undefined;
  const normText = (v: unknown) => String(v ?? "").trim().toLowerCase();
  const fields: Record<string, [string, string, (v: unknown) => string]> = {
    firstname: [record?.firstname, claimed.firstname, normText],
    surname: [record?.surname, claimed.surname, normText],
    gender: [record?.gender, claimed.gender, normalizeGender],
    birthdate: [record?.birthdate, claimed.birthdate, normalizeDob],
  };
  const matches: Record<string, boolean> = {};
  for (const [key, [actual, claim, norm]] of Object.entries(fields)) {
    if (claim === undefined || claim === "") continue;
    matches[key] = norm(actual) === norm(claim);
  }
  return matches;
}

interface ProviderOutcome {
  ok: boolean;
  record?: any;
  errorMessage?: string;
  isTestData?: boolean;
  // The provider was reached and answered cleanly, but has no record for this
  // number — a definitive miss, not an outage. Callers skip the fallback on
  // this so an invalid number doesn't cost a second lookup.
  notFound?: boolean;
}

// Both providers wrap the person's record at DIFFERENT depths and their live
// nesting differs from their own docs (Prembly: data.data; CheckMyNINBVN's
// live response nests it one level deeper at data.data.data — confirmed
// 2026-07-05). Find the record wherever it lives by walking candidate paths
// and returning the first object that actually carries an identity field.
// Robust to future nesting changes on either side.
function extractRecord(data: any): any {
  const candidates = [data?.data?.data, data?.data, data];
  for (const c of candidates) {
    if (
      c && typeof c === "object" && typeof c.firstname === "string" &&
      c.firstname.trim().length > 0
    ) {
      return c;
    }
  }
  return undefined;
}

// CheckMyNINBVN — FALLBACK.
async function tryNinBvn(nin: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyNinBvn(nin);
  const record = extractRecord(data);
  const ok = status < 400 && !!record;
  const errorMessage = ok
    ? undefined
    : (data?.message || data?.data?.message || `http_${status}`);
  return { ok, record, errorMessage };
}

// Prembly — PRIMARY (funded account, live real data, confirmed 2026-07-06).
async function tryPrembly(nin: string): Promise<ProviderOutcome> {
  const { status, data } = await verifyNinPrembly(nin);
  const record = extractRecord(data);
  const isTestData = typeof data?.message === "string" &&
    /test data/i.test(data.message);
  const ok = status < 400 && !!record && !isTestData;
  // 2xx + no record + not test data = the number genuinely isn't on file.
  const notFound = status >= 200 && status < 300 && !record && !isTestData;
  return { ok, record, errorMessage: data?.message, isTestData, notFound };
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isNinBvnConfigured() && !isPremblyConfigured()) {
    return json({ error: "NIN verification not configured" }, 500);
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

  const nin = String(body?.nin || "").trim();
  if (!/^\d{11}$/.test(nin)) {
    return json({ success: false, error: "Enter a valid 11-digit NIN" }, 400);
  }

  const supabase = adminClient();
  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({
      error: "This device session has been revoked. Please log in again.",
    }, 401);
  }

  const rate = await enforceRateLimit(
    supabase,
    "nin_verify",
    user.id,
    6,
    3600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many NIN verification attempts. Please wait and try again.",
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
  const claimed = body.claimed as Record<string, string> | undefined;

  // Which slip the user chose up front decides the price. Validate against our
  // own map — never trust a client-sent amount.
  const slipTier = Object.prototype.hasOwnProperty.call(
      SLIP_PRICE_KOBO,
      String(body?.slip_tier),
    )
    ? String(body.slip_tier)
    : DEFAULT_SLIP_TIER;
  const priceKobo = SLIP_PRICE_KOBO[slipTier];

  // CACHE: if this user already verified this same NIN in the last 24h,
  // serve our stored copy — no new charge and, crucially, no provider call.
  // CheckMyNINBVN rate-limits repeat lookups of the same NIN (confirmed to
  // last far longer than the "1 minute" its message claims), so re-hitting
  // the provider for a repeat is both a waste of money and a guaranteed
  // failure. NIN records essentially never change day-to-day.
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const { data: cachedTx } = await supabase
    .from("transactions")
    .select("id, metadata")
    .eq("user_id", user.id)
    .eq("type", "nin_verification")
    .eq("status", "completed")
    .eq("recipient_phone", nin)
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (cachedTx?.metadata?.record?.firstname) {
    const cachedTier = cachedTx.metadata.slip_tier || DEFAULT_SLIP_TIER;
    // Same NIN + same slip type within 24h → free re-access (re-download).
    if (cachedTier === slipTier) {
      return json({
        success: true,
        transaction_id: cachedTx.id,
        record: cachedTx.metadata.record,
        matches: buildMatchReport(cachedTx.metadata.record, claimed),
        cached: true,
      });
    }
    // Different slip type (e.g. upgrading Regular → Card): reuse the already
    // verified record (no provider re-call), but charge the new type's price so
    // a cheaper prior lookup can't unlock a pricier slip for free.
    const { data: upTxId, error: upErr } = await supabase.rpc(
      "debit_for_service",
      {
        p_user_id: user.id,
        p_amount: priceKobo,
        p_type: "nin_verification",
        p_network: "N/A",
        p_recipient: nin,
        p_metadata: {
          service: "nin_verification",
          slip_tier: slipTier,
          claimed: claimed ?? null,
        },
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
      p_order_id: nin,
    });
    await supabase
      .from("transactions")
      .update({
        metadata: {
          service: "nin_verification",
          slip_tier: slipTier,
          claimed: claimed ?? null,
          provider: "cache",
          record: cachedTx.metadata.record,
        },
      })
      .eq("id", upTxId);
    return json({
      success: true,
      transaction_id: upTxId,
      record: cachedTx.metadata.record,
      matches: buildMatchReport(cachedTx.metadata.record, claimed),
      cached: true,
    });
  }

  const { data: txId, error: debitError } = await supabase.rpc(
    "debit_for_service",
    {
      p_user_id: user.id,
      p_amount: priceKobo,
      p_type: "nin_verification",
      p_network: "N/A",
      p_recipient: nin,
      p_metadata: {
        service: "nin_verification",
        slip_tier: slipTier,
        claimed: claimed ?? null,
      },
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

  // Prembly first — owner's funded account, confirmed working end-to-end
  // 2026-07-06. CheckMyNINBVN as fallback.
  let outcome: ProviderOutcome = { ok: false };
  let providerUsed = "";
  let lastError: string | undefined; // shown to the user
  let primaryError: string | undefined; // primary provider's real reason — always kept for diagnosis, never overwritten
  let isCooldown = false; // CheckMyNINBVN rate-limits repeat lookups of the same NIN — confirmed 2026-07-05

  if (isPremblyConfigured()) {
    try {
      outcome = await tryPrembly(nin);
      providerUsed = "prembly";
      if (!outcome.ok && !outcome.isTestData) {
        primaryError = outcome.errorMessage;
        lastError = outcome.notFound
          ? "No record found for this NIN. Please check the number and try again."
          : outcome.errorMessage;
      } else if (!outcome.ok && outcome.isTestData) {
        primaryError = "prembly_test_data";
        lastError =
          "Verification is temporarily unavailable. Please try again shortly.";
      }
    } catch (e) {
      primaryError = (e as Error).message;
      lastError = primaryError;
    }
  }

  // Fall back ONLY on a real provider failure (outage / timeout / error) — not
  // on a definitive "not found", so an invalid NIN doesn't cost a second lookup.
  if (!outcome.ok && !outcome.notFound && isNinBvnConfigured()) {
    try {
      const fallback = await tryNinBvn(nin);
      if (fallback.ok) {
        outcome = fallback;
        providerUsed = "checkmyninbvn";
      } else {
        isCooldown = /recent verification/i.test(fallback.errorMessage || "");
        lastError = isCooldown
          ? "This NIN was looked up recently and the provider is blocking repeat checks for a while. Please try again later."
          : fallback.errorMessage || lastError;
      }
    } catch (e) {
      lastError = (e as Error).message;
    }
  }

  if (!outcome.ok) {
    // Logged reason keeps CheckMyNINBVN's real error (primaryError) even
    // when it gets superseded by a friendlier user-facing message below —
    // otherwise the actual cause of a failure is lost.
    await supabase.rpc("refund_service_transaction", {
      p_tx_id: txId,
      p_reason: JSON.stringify({ primary: primaryError, shown: lastError })
        .slice(0, 500),
    });
    return json({
      success: false,
      error: lastError || "Could not verify this NIN. Please try again.",
    });
  }

  await supabase.rpc("complete_service_transaction", {
    p_tx_id: txId,
    p_order_id: nin,
  });

  // Persist the verified record so the print-slip feature (and Transaction
  // History) can redisplay it later without paying again.
  await supabase
    .from("transactions")
    .update({
      metadata: {
        service: "nin_verification",
        slip_tier: slipTier,
        claimed: claimed ?? null,
        provider: providerUsed,
        record: outcome.record,
      },
    })
    .eq("id", txId);

  return json({
    success: true,
    transaction_id: txId,
    record: outcome.record,
    matches: buildMatchReport(outcome.record, claimed),
  });
});
