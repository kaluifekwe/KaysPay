import {
  normalizeVTUAfricaResult,
  vtuAfricaOutcome,
} from "./vtuafrica-client.ts";

function assertEquals(actual: unknown, expected: unknown, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

Deno.test("classifies numeric completed response as success", () => {
  assertEquals(
    vtuAfricaOutcome({ code: 101, description: { Status: "Completed" } }),
    "success",
    "numeric success code",
  );
});

Deno.test("classifies string completed response as success", () => {
  assertEquals(
    vtuAfricaOutcome({ code: "101", description: { Status: " Completed " } }),
    "success",
    "string success code",
  );
});

Deno.test("normalizes status and provider reference", () => {
  const normalized = normalizeVTUAfricaResult({
    code: "101",
    description: { status: "PROCESSING", ref: 12345 },
  });
  assertEquals(normalized.code, 101, "normalized code");
  assertEquals(normalized.status, "processing", "normalized status");
  assertEquals(normalized.reference, "12345", "normalized reference");
  assertEquals(vtuAfricaOutcome({ code: "101", description: { status: "PROCESSING" } }), "pending", "pending outcome");
});

Deno.test("only explicit terminal failure status is refundable", () => {
  assertEquals(
    vtuAfricaOutcome({ code: 500, description: { Status: "Failed" } }),
    "failed",
    "explicit failure",
  );
  assertEquals(
    vtuAfricaOutcome({ code: 500, description: { message: "Temporary provider error" } }),
    "unknown",
    "ambiguous non-101 response",
  );
  assertEquals(vtuAfricaOutcome(null), "unknown", "empty response");
});
