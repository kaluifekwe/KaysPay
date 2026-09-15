import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type FundingProvider = "paystack" | "flutterwave" | "9psb";
export type FundingSource = "webhook" | "reconcile";

export interface FundingCandidate {
  provider: FundingProvider;
  reference: string;
  transactionId?: string | null;
  amountKobo: number;
  currency: string;
  accountNumber?: string | null;
  customerCode?: string | null;
  virtualAccountId?: string | null;
  providerCreatedAt?: string | null;
  source: FundingSource;
}

export interface FundingCreditResult {
  outcome: "credited" | "duplicate" | "held" | "unmatched" | "rejected";
  userId?: string;
}

const MAX_REFERENCE_LENGTH = 200;

async function updateEvent(
  db: SupabaseClient,
  candidate: FundingCandidate,
  values: Record<string, unknown>,
) {
  const { error } = await db
    .from("funding_events")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("provider", candidate.provider)
    .eq("provider_reference", candidate.reference);
  if (error) throw error;
}

async function ensureEvent(db: SupabaseClient, candidate: FundingCandidate) {
  const now = new Date().toISOString();
  const { error: insertError } = await db.from("funding_events").insert({
    provider: candidate.provider,
    provider_reference: candidate.reference,
    provider_transaction_id: candidate.transactionId || null,
    amount_kobo: candidate.amountKobo,
    currency: candidate.currency,
    receiving_account: candidate.accountNumber || null,
    provider_customer_code: candidate.customerCode || null,
    provider_virtual_account_id: candidate.virtualAccountId || null,
    provider_created_at: candidate.providerCreatedAt || null,
    event_source: candidate.source,
    status: "received",
    last_seen_at: now,
  });
  const inserted = !insertError;
  if (insertError && insertError.code !== "23505") throw insertError;

  const { data: existing, error: readError } = await db
    .from("funding_events")
    .select("amount_kobo, currency, receiving_account, provider_customer_code, provider_virtual_account_id, attempts")
    .eq("provider", candidate.provider)
    .eq("provider_reference", candidate.reference)
    .maybeSingle();
  if (readError || !existing) throw readError || new Error("FUNDING_EVENT_NOT_RECORDED");

  // Compare identifiers only where BOTH sides actually carry one. The same
  // reference legitimately arrives with different fields depending on source:
  // a Paystack webhook has the receiving account but no reason to repeat the
  // customer code, while the reconciliation sweep has only the customer code.
  // Demanding an exact account match would flag an already-credited event as
  // a payload mismatch the first time the sweep re-examined it. Amount and
  // currency stay strictly compared, and a genuine conflict — two different
  // accounts claiming one reference — is still rejected.
  // 9PSB has no separate DVA-id concept — account_number IS the sole
  // identifier (already uniquely indexed across all providers, migration
  // 090), so its match check is account-number-only, unlike Paystack/
  // Flutterwave's account-or-customer-code pairs.
  let identifierMatches: boolean;
  if (candidate.provider === "paystack") {
    identifierMatches =
      (!candidate.accountNumber || !existing.receiving_account ||
        String(existing.receiving_account) === String(candidate.accountNumber)) &&
      (!candidate.customerCode || !existing.provider_customer_code ||
        String(existing.provider_customer_code) === String(candidate.customerCode));
  } else if (candidate.provider === "9psb") {
    identifierMatches = !candidate.accountNumber || !existing.receiving_account ||
      String(existing.receiving_account) === String(candidate.accountNumber);
  } else {
    identifierMatches =
      (!candidate.virtualAccountId || !existing.provider_virtual_account_id ||
        String(existing.provider_virtual_account_id) === String(candidate.virtualAccountId)) &&
      (!candidate.customerCode || !existing.provider_customer_code ||
        String(existing.provider_customer_code) === String(candidate.customerCode));
  }
  if (
    Number(existing.amount_kobo) !== candidate.amountKobo ||
    String(existing.currency) !== candidate.currency ||
    !identifierMatches
  ) {
    await updateEvent(db, candidate, {
      status: "error",
      error_code: "REFERENCE_PAYLOAD_MISMATCH",
      last_seen_at: new Date().toISOString(),
      attempts: Number(existing.attempts || 1) + (inserted ? 0 : 1),
    });
    throw new Error("REFERENCE_PAYLOAD_MISMATCH");
  }

  const update: Record<string, unknown> = {
    last_seen_at: now,
    attempts: Number(existing.attempts || 1) + (inserted ? 0 : 1),
  };
  if (candidate.transactionId) update.provider_transaction_id = candidate.transactionId;
  if (candidate.virtualAccountId) update.provider_virtual_account_id = candidate.virtualAccountId;
  if (candidate.customerCode) update.provider_customer_code = candidate.customerCode;
  await updateEvent(db, candidate, update);
}

async function resolveUserId(db: SupabaseClient, candidate: FundingCandidate): Promise<string | null> {
  if (candidate.provider === "paystack") {
    // Webhook payloads identify the destination by account number; the
    // reconciliation sweep only ever gets customer_code (see
    // normalizePaystackFunding). Both map to the same virtual_accounts row,
    // so accept either rather than dropping the money when one is absent.
    if (candidate.accountNumber) {
      const { data, error } = await db
        .from("virtual_accounts")
        .select("user_id")
        .eq("provider", "paystack")
        .eq("account_number", candidate.accountNumber)
        .maybeSingle();
      if (error) throw error;
      if (data?.user_id) return data.user_id;
    }
    if (!candidate.customerCode) return null;
    const { data, error } = await db
      .from("virtual_accounts")
      .select("user_id")
      .eq("provider", "paystack")
      .eq("customer_code", candidate.customerCode)
      .maybeSingle();
    if (error) throw error;
    return data?.user_id || null;
  }

  if (candidate.provider === "9psb") {
    if (!candidate.accountNumber) return null;
    const { data, error } = await db
      .from("virtual_accounts")
      .select("user_id")
      .eq("provider", "9psb")
      .eq("account_number", candidate.accountNumber)
      .maybeSingle();
    if (error) throw error;
    return data?.user_id || null;
  }

  if (candidate.virtualAccountId) {
    const { data, error } = await db
      .from("virtual_accounts")
      .select("user_id")
      .eq("provider", "flutterwave")
      .eq("dva_id", candidate.virtualAccountId)
      .maybeSingle();
    if (error) throw error;
    if (data?.user_id) return data.user_id;
  }
  if (!candidate.customerCode) return null;
  const { data, error } = await db
    .from("virtual_accounts")
    .select("user_id")
    .eq("provider", "flutterwave")
    .eq("customer_code", candidate.customerCode)
    .maybeSingle();
  if (error) throw error;
  return data?.user_id || null;
}

export async function processFundingCandidate(
  db: SupabaseClient,
  candidate: FundingCandidate,
): Promise<FundingCreditResult> {
  candidate.reference = String(candidate.reference || "").trim();
  candidate.currency = String(candidate.currency || "").trim().toUpperCase();
  if (
    !candidate.reference || candidate.reference.length > MAX_REFERENCE_LENGTH ||
    !Number.isSafeInteger(candidate.amountKobo) || candidate.amountKobo <= 0 ||
    candidate.currency !== "NGN"
  ) {
    return { outcome: "rejected" };
  }

  await ensureEvent(db, candidate);
  const userId = await resolveUserId(db, candidate);
  if (!userId) {
    await updateEvent(db, candidate, {
      status: "unmatched",
      error_code: "VIRTUAL_ACCOUNT_NOT_MAPPED",
      processed_at: new Date().toISOString(),
    });
    return { outcome: "unmatched" };
  }

  // Settled money is recognised BEFORE the KYC gate below. Order matters: the
  // duplicate test used to live inside credit_wallet_funding, which an
  // unverified user never reaches, so re-reading an already-credited payment
  // held money that had in fact been in the customer's wallet for days. They
  // were then told to verify their identity "before it can be added to your
  // wallet" — about a balance they could already see and spend.
  //
  // A payment that is already credited is finished. Nothing about the
  // customer's KYC state can make it un-happen, so there is nothing to hold.
  const { data: alreadyCredited, error: creditedError } = await db.rpc("funding_already_credited", {
    p_user_id: userId,
    p_reference: candidate.reference,
    p_amount: candidate.amountKobo,
    p_source: candidate.provider,
  });
  if (creditedError) {
    await updateEvent(db, candidate, { status: "error", error_code: "CREDITED_LOOKUP_FAILED" });
    throw creditedError;
  }
  if (alreadyCredited === true) {
    await updateEvent(db, candidate, {
      user_id: userId,
      status: "duplicate",
      error_code: null,
      processed_at: new Date().toISOString(),
    });
    return { outcome: "duplicate", userId };
  }

  // KYC is enforced here, at the shared server-side money boundary. This
  // protects old app builds and modified clients as well as the latest UI.
  // A real provider transfer is never discarded: it is durably held without
  // increasing the spendable wallet balance, then released after verification.
  const { data: kyc, error: kycError } = await db
    .from("user_kyc")
    .select("status")
    .eq("user_id", userId)
    .maybeSingle();
  if (kycError) {
    await updateEvent(db, candidate, { status: "error", error_code: "KYC_LOOKUP_FAILED" });
    throw kycError;
  }
  if (kyc?.status !== "verified") {
    const { data: holdData, error: holdError } = await db.rpc("hold_wallet_funding", {
      p_user_id: userId,
      p_reference: candidate.reference,
      p_amount: candidate.amountKobo,
      p_source: candidate.provider,
      p_event_source: candidate.source,
    });
    if (holdError) {
      await updateEvent(db, candidate, { status: "error", error_code: "COMPLIANCE_HOLD_FAILED" });
      throw holdError;
    }
    // KYC may have completed after the lookup above. The database function
    // resolves that race atomically and can route the money to normal credit.
    if (holdData?.held !== true) {
      const routedOutcome = holdData?.credited === true ? "credited" : "duplicate";
      await updateEvent(db, candidate, {
        user_id: userId,
        status: routedOutcome,
        error_code: null,
        processed_at: new Date().toISOString(),
      });
      return { outcome: routedOutcome, userId };
    }
    await updateEvent(db, candidate, {
      user_id: userId,
      status: "held",
      error_code: "KYC_REQUIRED",
      processed_at: new Date().toISOString(),
    });
    return { outcome: "held", userId };
  }

  const { data, error } = await db.rpc("credit_wallet_funding", {
    p_user_id: userId,
    p_reference: candidate.reference,
    p_amount: candidate.amountKobo,
    p_source: candidate.provider,
  });
  if (error) {
    await updateEvent(db, candidate, { status: "error", error_code: "WALLET_CREDIT_FAILED" });
    throw error;
  }

  const outcome = data?.credited === true ? "credited" : "duplicate";
  await updateEvent(db, candidate, {
    user_id: userId,
    status: outcome,
    error_code: null,
    processed_at: new Date().toISOString(),
  });
  return { outcome, userId };
}
