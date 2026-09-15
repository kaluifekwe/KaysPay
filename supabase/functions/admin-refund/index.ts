import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError, isServiceEnabled } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import {
  confirmServiceRefund,
  RefundRecoveryQueueError,
} from "../_shared/service-refund.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  isVtuNaijaConfigured,
  normalizeVTUNaijaQueryResult,
  queryVTUNaijaTransaction,
} from "../_shared/vtunaija-client.ts";
import { is9PsbConfigured, otherBanksEnquiry, walletOtherBanks, walletRequery } from "../_shared/9psb-client.ts";
import { startNinePsbProvisioning } from "../_shared/9psb-provisioning.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Types where the transaction row represents a single debit from
// wallets.balance (never a credit, never a second balance) �?the only
// types where refund_service_transaction / refund_completed_service_transaction
// are safe to run as-is. wallet_fund/card_fund/refund/payroll/withdrawal
// and crypto_buy/crypto_sell are all deliberately excluded �?see the
// Phase 2 plan for exactly why each one is dangerous here (double-credit,
// two-sided balance, or dead/never-created).
const SIMPLE_REFUNDABLE_TYPES = new Set([
  "airtime", "data", "bill", "exam_pin", "esim", "foreign_number",
  "nin_verification", "nin_validation", "bvn_verification",
  "nin_name_modification", "nin_phone_modification", "nin_address_modification",
]);

interface TxRow {
  id: string;
  user_id: string;
  type: string;
  status: string;
  amount_ngn: number;
  metadata: Record<string, unknown> | null;
}

const PROVIDER_VERIFIED_TYPES = new Set(["airtime", "data", "bill", "exam_pin"]);

type ProviderVerification = {
  outcome: "success" | "failed" | "processing" | "unknown";
  provider: string;
  queryReference: string;
  providerTransactionId: string | null;
  message: string;
};

async function verifyProviderOutcome(tx: TxRow): Promise<ProviderVerification> {
  const provider = String(tx.metadata?.provider || "");
  const idempotencyKey = String(tx.metadata?.idempotency_key || "");
  const providerTransactionId = tx.metadata?.provider_transaction_id
    ? String(tx.metadata.provider_transaction_id)
    : null;
  // VTUnaija's query endpoint is keyed by the same `request-id` value WE
  // submitted at purchase time (idempotency_key) — providerTransactionId is
  // a separate, provider-assigned id from the purchase response and was
  // never a valid query key. Kept as a last-resort fallback only for the
  // rare row missing an idempotency_key (see vtunaija-client.ts's
  // queryVTUNaijaTransaction docstring).
  const queryReference = idempotencyKey || providerTransactionId || "";

  if (!provider || !queryReference) {
    return { outcome: "unknown", provider: provider || "unknown", queryReference, providerTransactionId, message: "Missing provider query reference" };
  }

  if (provider === "vtunaija") {
    if (!isVtuNaijaConfigured()) {
      return { outcome: "unknown", provider, queryReference, providerTransactionId, message: "Provider verification is not configured" };
    }
    const result = await queryVTUNaijaTransaction(queryReference);
    const normalized = normalizeVTUNaijaQueryResult(result);
    return {
      outcome: normalized.outcome,
      provider,
      queryReference,
      providerTransactionId: normalized.transactionId ?? providerTransactionId,
      message: normalized.message || "Provider returned no settlement message",
    };
  }

  return { outcome: "unknown", provider, queryReference, providerTransactionId, message: "This provider has no admin refund verification adapter" };
}

serve(async (req) => {
  const cors = handleCors(req);
  if (cors) return cors;
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let admin;
  try {
    admin = await requireAdmin(req, "super_admin");
  } catch (e) {
    if (e instanceof AdminAuthError) return json({ error: e.message }, e.status);
    return json({ error: "Unauthorized" }, 401);
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBody(req, 1024);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ error: e.message }, e.status);
  }

  // Third, unrelated action folded into this function to stay under
  // Supabase's 100-function project cap (same reason wallet_correction and
  // delete_account below are here too) -- an admin/closed-testing-only way
  // to prove 9PSB's wallet_other_banks transfer-out API works end to end,
  // using 9PSB's own sandbox wallets directly. Never touches KaysPay's
  // wallets table or debit_for_transfer RPC -- real customer transfers keep
  // working through transfer-send.ts's Flutterwave->Paystack chain,
  // completely untouched. See the approved 9PSB WAAS plan's Deployment
  // constraints (preview channel + closed testing track only) and §5.
  if (body.target === "9psb_transfer_test") {
    const db = adminClient();
    if (!(await isServiceEnabled(db, "9psb_waas"))) {
      return json({ error: "9PSB integration isn't enabled." }, 503);
    }
    if (!is9PsbConfigured()) {
      return json({ error: "9PSB isn't configured." }, 503);
    }

    const senderAccountNumber = String(body.sender_account_number || "");
    const senderName = String(body.sender_name || "");
    const bank = String(body.bank_code || "");
    const recipientNumber = String(body.recipient_account_number || "");
    const recipientName = String(body.recipient_name || "");
    const amountNaira = String(body.amount_naira || "");
    if (!senderAccountNumber || !senderName || !bank || !recipientNumber || !recipientName || !amountNaira) {
      return json({ error: "Missing required test-transfer fields" }, 400);
    }

    // Same name-resolution safety net already used for the Paystack
    // fallback in transfer-send.ts, reimplemented locally (not imported --
    // transfer-send.ts is not touched by this build) so an imprecise
    // bank-code/name match can never send money to the wrong place.
    const namesRoughlyMatch = (a: string, b: string) => {
      const norm = (s: string) => s.toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean).sort().join(" ");
      return norm(a) === norm(b);
    };

    const enquiry = await otherBanksEnquiry(db, { bank, number: recipientNumber });
    const resolvedName = enquiry.data?.data?.name || enquiry.data?.name;
    if (enquiry.status >= 400 || !resolvedName) {
      return json({ error: "Could not resolve the recipient account" }, 400);
    }
    if (!namesRoughlyMatch(resolvedName, recipientName)) {
      return json({ error: "The recipient name doesn't match the account on file. Refusing to send.", resolved_name: resolvedName }, 409);
    }

    const reference = `9psbtest${Date.now()}`;
    const transferRes = await walletOtherBanks(db, {
      senderAccountNumber,
      senderName,
      bank,
      recipientName: resolvedName,
      recipientNumber,
      amountNaira,
      reference,
      narration: "9PSB integration test transfer",
    });

    // NIBSS-style response codes 9PSB documents: 00 = approved. 51/61/91 =
    // definitive rejection. 09/96/97/98/99 = ambiguous, requery required
    // before assuming either way -- same "requery, don't guess" discipline
    // already used for Flutterwave/Paystack transfer settlement.
    const code = String(transferRes.data?.responseCode ?? transferRes.data?.code ?? "");
    if (code === "00") {
      return json({ success: true, status: "pending", reference, response_code: code });
    }
    if (code === "51" || code === "61" || code === "91") {
      return json({ success: false, status: "rejected", reference, response_code: code, message: transferRes.data?.message }, 400);
    }
    if (["09", "96", "97", "98", "99"].includes(code) || transferRes.status >= 500) {
      const requery = await walletRequery(db, { transactionId: reference });
      return json({ success: true, status: "ambiguous_requeried", reference, response_code: code, requery_result: requery.data });
    }
    return json({ success: false, status: "unknown_response", reference, response_code: code, message: transferRes.data?.message }, 502);
  }

  // Fourth, unrelated action folded into this function for the same
  // 100-function-cap reason as the others here -- admin-triggered, batched
  // backfill that kicks off 9PSB provisioning's Call 1 for customers who
  // were already KYC-verified before this integration shipped (new
  // customers get this automatically via kyc-verify-nin's own hook; this
  // covers everyone who verified earlier). Deliberately NOT automatic on
  // deploy -- the owner runs this explicitly, only against closed-testing
  // accounts, once ready. Small batches (p_limit, default 5) since each
  // candidate costs a real call to 9PSB's sandbox; call repeatedly to work
  // through the full backlog.
  if (body.target === "9psb_backfill_provisioning") {
    const db = adminClient();
    if (!(await isServiceEnabled(db, "9psb_waas"))) {
      return json({ error: "9PSB integration isn't enabled." }, 503);
    }
    if (!is9PsbConfigured()) {
      return json({ error: "9PSB isn't configured." }, 503);
    }
    const limit = Math.max(1, Math.min(Number(body.limit) || 5, 20));

    const { data: candidates, error: candidatesError } = await db.rpc(
      "admin_list_kyc_verified_without_9psb_wallet",
      { p_limit: limit },
    );
    if (candidatesError) throw candidatesError;

    const results: Array<{ user_id: string; outcome: string; detail?: string }> = [];
    for (const c of candidates ?? []) {
      const verifiedIdentifier = String(c.nin || c.bvn || "").trim();
      if (!/^\d{11}$/.test(verifiedIdentifier)) {
        results.push({ user_id: c.user_id, outcome: "skipped", detail: "incomplete identity record" });
        continue;
      }
      try {
        const result = await startNinePsbProvisioning(db, {
          userId: c.user_id,
          verifiedIdentifier,
          usingNin: !!c.nin,
          phone: c.phone || undefined,
        });
        results.push({ user_id: c.user_id, outcome: result.outcome, detail: result.outcome === "error" ? result.message : undefined });
      } catch (e) {
        results.push({ user_id: c.user_id, outcome: "error", detail: e instanceof Error ? e.message : "unknown error" });
      }
    }

    return json({ success: true, processed: results.length, results });
  }

  // Second, unrelated action folded into this function to stay under
  // Supabase's 100-function project cap (same reason crypto-swap's quote
  // mode was merged into crypto-swap itself) -- manually debits a wallet for
  // money that already moved outside the normal in-app flow (e.g. a customer
  // funded the wallet for a crypto purchase, paid by bank transfer and never
  // completed, and support already refunded them manually). Returns before
  // any of the transaction-refund logic below runs; a request without
  // `target` set falls through to that existing behavior completely
  // unchanged. See admin_wallet_correction, migration 218.
  if (body.target === "wallet_correction") {
    const userId = String(body.user_id || "");
    const amountKobo = Math.round(Number(body.amount_kobo));
    const correctionReason = String(body.reason || "").trim().slice(0, 500);
    if (!UUID_PATTERN.test(userId)) return json({ error: "Invalid user_id" }, 400);
    if (!Number.isFinite(amountKobo) || amountKobo <= 0) return json({ error: "Enter a valid amount" }, 400);
    if (correctionReason.length < 5) return json({ error: "A reason (at least 5 characters) is required" }, 400);

    const db = adminClient();
    const { data, error } = await db.rpc("admin_wallet_correction", {
      p_admin_user_id: admin.userId,
      p_user_id: userId,
      p_amount_kobo: amountKobo,
      p_reason: correctionReason,
    });
    if (error) {
      const message = error.message?.includes("INSUFFICIENT_BALANCE")
        ? "This customer's wallet doesn't have that much available."
        : error.message?.includes("WALLET_NOT_FOUND")
        ? "Could not find this customer's wallet."
        : "Could not complete the correction.";
      return json({ error: message }, 400);
    }

    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "wallet_manual_correction",
      target_type: "users",
      target_id: userId,
      reason: correctionReason,
      metadata: { amount_kobo: amountKobo, transaction_id: data?.transaction_id, new_balance_kobo: data?.new_balance },
    });

    return json({ success: true, transaction_id: data?.transaction_id, new_balance_kobo: data?.new_balance });
  }

  // Third, unrelated action folded in here for the same 100-function-cap
  // reason as wallet_correction above. Deletes a customer's personal/KYC
  // data on request while leaving their transaction history untouched (see
  // admin_delete_customer_account, migration 221, and the published policy
  // at kayspay-web/public/delete-account/index.html). The DB-side RPC runs
  // first and blocks on its own if the wallet still holds funds or has a
  // hold in flight, so nothing here can lock a customer out of an account
  // that still needs their attention. Disabling the Auth login afterward is
  // best-effort: the destructive DB deletion already happened either way,
  // so a failure here is surfaced rather than silently swallowed.
  if (body.target === "delete_account") {
    const userId = String(body.user_id || "");
    const deletionReason = String(body.reason || "").trim().slice(0, 500);
    const confirmBalanceHandled = body.confirm_balance_handled === true;
    if (!UUID_PATTERN.test(userId)) return json({ error: "Invalid user_id" }, 400);
    if (deletionReason.length < 5) return json({ error: "A reason (at least 5 characters) is required" }, 400);

    const db = adminClient();
    const { data: authUser, error: lookupError } = await db.auth.admin.getUserById(userId);
    if (lookupError || !authUser?.user) return json({ error: "Could not find this customer's account" }, 404);

    const { data, error: rpcError } = await db.rpc("admin_delete_customer_account", {
      p_admin_user_id: admin.userId,
      p_user_id: userId,
      p_reason: deletionReason,
      p_confirm_balance_handled: confirmBalanceHandled,
    });

    if (rpcError) {
      const message = rpcError.message || "";
      if (message.includes("USER_NOT_FOUND")) return json({ error: "Could not find this customer's account" }, 404);
      if (message.includes("ADMIN_ACCOUNT_NOT_DELETABLE")) {
        return json({ error: "Administrator accounts must be offboarded (removed from Admins) before deletion." }, 403);
      }
      if (message.includes("ALREADY_DELETED")) return json({ error: "This account has already been deleted" }, 409);
      if (message.includes("WALLET_LOCKED_FUNDS")) {
        return json({ error: "This customer has a transaction in progress. Try again once it settles." }, 409);
      }
      if (message.includes("WALLET_BALANCE_NOT_ZERO")) {
        return json({
          error: "This customer's wallet still has a balance. Confirm how it was handled before deleting the account.",
          code: "WALLET_BALANCE_NOT_ZERO",
        }, 409);
      }
      return json({ error: "Could not delete this account" }, 500);
    }

    const placeholderEmail = `deleted-${userId}@kayspay.invalid`;
    const { error: authError } = await db.auth.admin.updateUserById(userId, {
      email: placeholderEmail,
      email_confirm: true,
      phone: null,
      user_metadata: {},
      ban_duration: "876000h",
    });

    await db.from("admin_actions").insert({
      admin_user_id: admin.userId,
      action_type: "account_deletion",
      target_type: "users",
      target_id: userId,
      reason: deletionReason,
      metadata: {
        confirm_balance_handled: confirmBalanceHandled,
        balance_cleared_kobo: data?.balance_cleared_kobo ?? 0,
        login_disabled: !authError,
      },
    });

    if (authError) {
      return json({
        success: true,
        warning: "Account data was deleted, but the login could not be disabled. Retry to finish disabling it.",
        summary: data,
      }, 200);
    }

    return json({ success: true, summary: data });
  }

  const transactionId = String(body.transaction_id || "");
  const reason = String(body.reason || "").trim().slice(0, 500);
  if (!transactionId) return json({ error: "transaction_id required" }, 400);
  if (reason.length < 5) return json({ error: "A reason (at least 5 characters) is required" }, 400);

  const db = adminClient();
  const { data: tx, error: fetchError } = await db
    .from("transactions")
    .select("id, user_id, type, status, amount_ngn, metadata")
    .eq("id", transactionId)
    .maybeSingle<TxRow>();
  if (fetchError) return json({ error: "Could not load transaction" }, 500);
  if (!tx) return json({ error: "Transaction not found" }, 404);

  if (tx.type === "crypto_withdraw" && tx.status === "pending") {
    // refund_crypto_withdrawal (retired) credited the local crypto_balances
    // ledger, which the live withdrawal flow never debits -- Quidax's
    // sub-account is the source of truth, settled here by
    // settle_crypto_withdrawal instead. It never moves anything back from
    // Quidax on its own: a withdrawal that already left the sub-account
    // needs a real Quidax-side reversal, confirmed separately, before this
    // is truly resolved -- this just marks the local record correctly so
    // it stops being reported as still-pending. Found by a Strix pentest
    // scan, 2026-09-12.
    const { error: rpcError } = await db.rpc("settle_crypto_withdrawal", {
      p_reference: String(tx.metadata?.quidax_reference || ""),
      p_succeeded: false,
      p_txid: null,
      p_reason: reason,
    });
    if (rpcError) return json({ error: "Crypto withdrawal refund failed" }, 500);
  } else if (SIMPLE_REFUNDABLE_TYPES.has(tx.type) && tx.status === "pending") {
    // Eligible: the service debit is still unresolved.
  } else {
    return json({
      error: SIMPLE_REFUNDABLE_TYPES.has(tx.type) || tx.type === "crypto_withdraw"
        ? "This transaction is already resolved and can't be refunded again"
        : "This transaction type can't be refunded from the admin panel",
    }, 400);
  }

  if (tx.type !== "crypto_withdraw") {
    if (PROVIDER_VERIFIED_TYPES.has(tx.type)) {
      let verification: ProviderVerification;
      try {
        verification = await verifyProviderOutcome(tx);
      } catch {
        return json({
          error: "The provider could not be reached, so this transaction was not refunded. Try verification again later.",
          code: "PROVIDER_VERIFICATION_UNAVAILABLE",
        }, 503);
      }

      const { data: evidenceRecorded, error: evidenceError } = await db.rpc("record_provider_refund_verification", {
        p_tx_id: transactionId,
        p_provider: verification.provider,
        p_outcome: verification.outcome,
        p_query_reference: verification.queryReference,
        p_provider_transaction_id: verification.providerTransactionId,
        p_message: verification.message,
      });
      if (evidenceError || evidenceRecorded !== true) {
        return json({ error: "Provider verification could not be recorded, so the refund was stopped.", code: "VERIFICATION_AUDIT_FAILED" }, 500);
      }

      if (verification.outcome === "success") {
        const { error: completeError } = await db.rpc("complete_service_transaction", {
          p_tx_id: transactionId,
          p_order_id: verification.providerTransactionId,
        });
        return json({
          error: completeError
            ? "The provider confirmed delivery, but local completion needs reconciliation. Refund blocked."
            : "The provider confirmed this service was delivered. The transaction was completed and cannot be refunded.",
          code: "PROVIDER_CONFIRMED_SUCCESS",
        }, 409);
      }

      if (verification.outcome !== "failed") {
        return json({
          error: "The provider has not confirmed failure. The transaction remains pending and was not refunded.",
          code: "PROVIDER_STATUS_UNKNOWN",
        }, 409);
      }
    }

    try {
      await confirmServiceRefund(db, transactionId, reason, "admin");
    } catch (error) {
      if (error instanceof RefundRecoveryQueueError) {
        return json({
          error: "The wallet refund was not confirmed and could not be queued. Escalate this transaction for manual review; do not submit it again.",
          code: "REFUND_QUEUE_FAILED",
        }, 500);
      }
      return json({
        error: "The wallet refund was not confirmed. It has been queued for reconciliation; do not submit it again.",
        code: "REFUND_UNCONFIRMED",
      }, 503);
    }
  }

  // The RPC silently no-ops (no error) if its own precondition wasn't met
  // (e.g. it was already refunded a moment ago) �?re-check the actual
  // outcome before reporting success rather than trusting "no error".
  const { data: after } = await db
    .from("transactions")
    .select("status, metadata")
    .eq("id", transactionId)
    .maybeSingle<{ status: string; metadata: Record<string, unknown> }>();

  // crypto_withdraw settles to 'failed' via settle_crypto_withdrawal (there
  // is no local balance to mark "refunded" -- see the comment above), every
  // other type settles to 'refunded' as before.
  const settled = tx.type === "crypto_withdraw"
    ? after?.status === "failed"
    : after?.status === "refunded" && after.metadata?.refunded === true;
  if (!settled) {
    return json({ error: "Refund could not be completed — it may have already been resolved" }, 409);
  }

  await db.from("admin_actions").insert({
    admin_user_id: admin.userId,
    action_type: "transaction_refund",
    target_type: "transactions",
    target_id: transactionId,
    reason,
    metadata: { user_id: tx.user_id, type: tx.type, amount_ngn: tx.amount_ngn },
  });

  return json({ success: true, refunded_amount_ngn: tx.amount_ngn });
});
