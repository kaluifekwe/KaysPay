import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, readJsonBody, RequestBodyError } from "../_shared/auth.ts";
import { AdminAuthError, requireAdmin } from "../_shared/admin-auth.ts";
import {
  confirmServiceRefund,
  RefundRecoveryQueueError,
} from "../_shared/service-refund.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  isVtuNaijaConfigured,
  normalizeVTUNaijaQueryResult,
  queryVTUNaijaDataTransaction,
  queryVTUNaijaTransaction,
} from "../_shared/vtunaija-client.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

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
  outcome: "success" | "failed" | "unknown";
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
  const queryReference = providerTransactionId || idempotencyKey;

  if (!provider || !queryReference) {
    return { outcome: "unknown", provider: provider || "unknown", queryReference, providerTransactionId, message: "Missing provider query reference" };
  }

  if (provider === "vtunaija") {
    if (!isVtuNaijaConfigured()) {
      return { outcome: "unknown", provider, queryReference, providerTransactionId, message: "Provider verification is not configured" };
    }
    const result = tx.type === "data"
      ? await queryVTUNaijaDataTransaction(queryReference)
      : await queryVTUNaijaTransaction(queryReference);
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
    const { error: rpcError } = await db.rpc("refund_crypto_withdrawal", { p_tx_id: transactionId, p_reason: reason });
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

  if (after?.status !== "refunded" || after.metadata?.refunded !== true) {
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
