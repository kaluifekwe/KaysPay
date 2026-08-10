import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type RefundOrigin = "automatic" | "reconcile" | "webhook" | "admin";

export class RefundUnconfirmedError extends Error {
  constructor() {
    super("SERVICE_REFUND_UNCONFIRMED");
    this.name = "RefundUnconfirmedError";
  }
}

export class RefundRecoveryQueueError extends Error {
  constructor() {
    super("SERVICE_REFUND_RECOVERY_QUEUE_FAILED");
    this.name = "RefundRecoveryQueueError";
  }
}

export async function confirmServiceRefund(
  db: SupabaseClient,
  transactionId: string,
  reason: string,
  origin: RefundOrigin,
  completed = false,
): Promise<void> {
  const rpc = completed
    ? "refund_completed_service_transaction_confirmed"
    : "refund_service_transaction_confirmed";
  const { data, error } = await db.rpc(rpc, {
    p_tx_id: transactionId,
    p_reason: reason,
    p_origin: origin,
  });
  if (!error && data === true) return;

  // Best-effort durable recovery. If the database itself is unavailable this
  // may fail too, so callers must still report Processing rather than claim a
  // refund that was not confirmed.
  const { error: queueError } = await db.rpc("enqueue_service_refund_recovery", {
    p_tx_id: transactionId,
    p_reason: reason,
    p_origin: origin,
    p_completed: completed,
  });
  if (queueError) throw new RefundRecoveryQueueError();
  await db.rpc("record_monitoring_alert", {
    p_fingerprint: `service_refund_unconfirmed_${origin}`,
    p_type: "service_refund_unconfirmed",
    p_severity: "critical",
    p_details: { origin, completed_transaction: completed },
  });
  throw new RefundUnconfirmedError();
}
