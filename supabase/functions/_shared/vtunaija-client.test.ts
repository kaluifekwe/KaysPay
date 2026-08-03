import { normalizeVTUNaijaResult, vtunaijaOutcome } from "./vtunaija-client.ts";

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
