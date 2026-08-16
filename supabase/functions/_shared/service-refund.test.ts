import { assertEquals, assertRejects } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  confirmServiceRefund,
  RefundRecoveryQueueError,
  RefundUnconfirmedError,
} from "./service-refund.ts";

Deno.test("confirmed refund returns only after database confirmation", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      return Promise.resolve({ data: true, error: null });
    },
  };
  await confirmServiceRefund(db as never, "tx-1", "provider rejected", "automatic");
  assertEquals(calls.length, 1);
  assertEquals(calls[0].name, "refund_service_transaction_confirmed");
});

Deno.test("queue failure is never reported as queued", async () => {
  const db = {
    rpc(name: string) {
      if (name === "refund_service_transaction_confirmed") {
        return Promise.resolve({ data: false, error: null });
      }
      return Promise.resolve({ data: null, error: new Error("queue unavailable") });
    },
  };
  await assertRejects(
    () => confirmServiceRefund(db as never, "tx-3", "provider rejected", "admin"),
    RefundRecoveryQueueError,
  );
});

Deno.test("unconfirmed refund is queued, alerted, and never reported as successful", async () => {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const db = {
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "refund_completed_service_transaction_confirmed") {
        return Promise.resolve({ data: false, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
  };
  await assertRejects(
    () => confirmServiceRefund(db as never, "tx-2", "expired no code", "admin", true),
    RefundUnconfirmedError,
  );
  assertEquals(calls.map((call) => call.name), [
    "refund_completed_service_transaction_confirmed",
    "enqueue_service_refund_recovery",
    "record_monitoring_alert",
  ]);
  assertEquals(calls[1].args.p_completed, true);
});
