import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { normalizeFlutterwaveFunding, normalizePaystackFunding } from "./funding-normalize.ts";

Deno.test("normalizes Paystack DVA success in kobo", () => {
  const result = normalizePaystackFunding({ id: 99, status: "success", reference: "ref-1", amount: 125000, currency: "NGN", authorization: { channel: "dedicated_nuban", receiver_bank_account_number: "1234567890" } });
  assertEquals(result?.amountKobo, 125000);
  assertEquals(result?.accountNumber, "1234567890");
});
Deno.test("rejects non-DVA Paystack charge", () => {
  assertEquals(normalizePaystackFunding({ status: "success", reference: "ref-2", amount: 10000, currency: "NGN", authorization: { channel: "card" } }), null);
});
Deno.test("normalizes Flutterwave bank-transfer amount from naira", () => {
  const result = normalizeFlutterwaveFunding({ id: "chg_1", status: "succeeded", amount: 1250.5, currency: "NGN", customer_id: "cus_1", virtual_account_id: "van_1" });
  assertEquals(result?.amountKobo, 125050);
  assertEquals(result?.virtualAccountId, "van_1");
});
Deno.test("rejects Flutterwave charge without virtual-account evidence", () => {
  assertEquals(normalizeFlutterwaveFunding({ id: "chg_2", status: "succeeded", amount: 100, currency: "NGN", customer_id: "cus_1", payment_method_details: { type: "card" } }), null);
});
