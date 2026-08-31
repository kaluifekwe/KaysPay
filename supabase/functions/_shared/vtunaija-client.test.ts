import {
  classifyVTUNaijaFailure,
  customerMessageForVTUNaijaFailure,
  normalizeVTUNaijaQueryResult,
  normalizeVTUNaijaResult,
  vtunaijaOutcome,
} from "./vtunaija-client.ts";

Deno.test("classifies gateway outages as provider failures with safe customer copy", () => {
  assertEquals(classifyVTUNaijaFailure("No active gateway found"), "gateway_unavailable", "gateway category");
  assertEquals(
    customerMessageForVTUNaijaFailure("No active gateway found"),
    "This plan is temporarily unavailable from the network. Your money has been refunded. Please choose another plan or try again later.",
    "gateway customer message",
  );
});

Deno.test("classifies SIM-selective subscriber rejection without exposing raw text", () => {
  const raw = "Subscriber is not eligible for this SIM selective plan";
  assertEquals(classifyVTUNaijaFailure(raw), "subscriber_ineligible", "eligibility category");
  assertEquals(
    customerMessageForVTUNaijaFailure(raw),
    "This plan is not available for this phone number. Your money has been refunded. Please choose another plan.",
    "eligibility customer message",
  );
});

function assertEquals(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

// Real success example from VTUnaija's own airtime docs, 2026-07-30.
Deno.test("classifies documented successful response as success", () => {
  const result = {
    Status: "successful",
    status: "success",
    api_response: "You have successfully sent Airtime of ₦500 to 08012345678. Your API airtime balance is ₦38,000",
    id: "78977865523",
    ident: "78977865523",
    plan_amount: "500",
  };
  assertEquals(vtunaijaOutcome(result), "success", "documented success");
  const normalized = normalizeVTUNaijaResult(result);
  assertEquals(normalized.statusOk, true, "normalized statusOk");
  assertEquals(normalized.id, "78977865523", "normalized id");
  assertEquals(normalized.planAmount, "500", "normalized plan_amount");
});

// Real Exam PIN success envelope supplied by the provider. PIN and serial are
// one-time values and must survive normalization intact.
Deno.test("preserves documented exam PIN and serial fields", () => {
  const normalized = normalizeVTUNaijaResult({
    Status: "successful",
    status: "success",
    api_response: "Transaction Successful",
    id: "78977865523",
    ident: "78977865523",
    plan_amount: "4500",
    pin: "12345678901234567",
    serial: "98765432101234567",
  });
  assertEquals(normalized.pin, "12345678901234567", "normalized PIN");
  assertEquals(normalized.serial, "98765432101234567", "normalized serial");
});

// Real failure example from the same docs.
Deno.test("classifies documented failed response as failed", () => {
  const result = {
    Status: "failed",
    status: "fail",
    api_response: "Failed Failed Failed. Something went wrong",
    id: "78977865523",
    ident: "78977865523",
    plan_amount: "0",
  };
  assertEquals(vtunaijaOutcome(result), "failed", "documented failure");
});

// Real error-response example (uses `message`, not `api_response` — the key
// naming inconsistency confirmed in VTUnaija's own docs).
Deno.test("classifies documented auth-error response (message key) as failed", () => {
  const result = {
    status: "fail",
    Status: "failed",
    message: "Missing or invalid API key in Authorization header. Format: Authorization: Token {api_key}",
  };
  assertEquals(vtunaijaOutcome(result), "failed", "auth error");
  assertEquals(
    normalizeVTUNaijaResult(result).message,
    "Missing or invalid API key in Authorization header. Format: Authorization: Token {api_key}",
    "normalized message falls back to `message` key",
  );
});

// No documented pending state exists for VTUnaija airtime/data — anything
// that isn't a clean success/fail match must be "unknown", never guessed.
Deno.test("treats malformed or empty response as unknown, not success or failure", () => {
  assertEquals(vtunaijaOutcome(null), "unknown", "null response");
  assertEquals(vtunaijaOutcome({}), "unknown", "empty object");
  assertEquals(vtunaijaOutcome({ Status: "weird-unrecognized-word" }), "unknown", "unrecognized status word");
});

Deno.test("uses nested transaction status for a successful query lookup", () => {
  const result = {
    status: "success",
    Status: "successful",
    message: "Transaction retrieved successfully.",
    data: {
      transaction_id: "209129180089",
      transaction_type: "DataShare3",
      size: "2GB Datashare",
      network: "MTN",
      status: "successful",
      api_response: "Y'ello! You have gifted 2GB.",
    },
  };
  const normalized = normalizeVTUNaijaQueryResult(result);
  assertEquals(normalized.outcome, "success", "nested successful transaction");
  assertEquals(normalized.transactionId, "209129180089", "nested transaction id");
  assertEquals(normalized.transactionType, "DataShare3", "nested transaction type");
  assertEquals(normalized.network, "MTN", "nested network");
});

Deno.test("does not mistake a successful lookup for a successful failed transaction", () => {
  const result = {
    status: "success",
    Status: "successful",
    message: "Transaction retrieved successfully.",
    data: {
      transaction_id: "209129180090",
      transaction_type: "DataShare3",
      size: "2GB Datashare",
      network: "MTN",
      status: "failed",
      api_response: "Failed Failed Failed. Something went wrong",
    },
  };
  const normalized = normalizeVTUNaijaQueryResult(result);
  assertEquals(normalized.outcome, "failed", "nested failed transaction");
  assertEquals(normalized.message, "Failed Failed Failed. Something went wrong", "nested failure message");
});

Deno.test("treats query auth errors and malformed successful lookups as unknown", () => {
  assertEquals(
    normalizeVTUNaijaQueryResult({ Status: "failed", status: "fail", message: "Invalid API key" }).outcome,
    "unknown",
    "query auth failure is not a customer transaction failure",
  );
  assertEquals(
    normalizeVTUNaijaQueryResult({ Status: "successful", status: "success", data: {} }).outcome,
    "unknown",
    "missing nested transaction status",
  );
});
