import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { readJsonBody, RequestBodyError } from "./auth.ts";
import { redactSecrets } from "./redact.ts";

Deno.test("readJsonBody accepts bounded JSON", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ ok: true }),
  });
  assertEquals(await readJsonBody(request, 128), { ok: true });
});

Deno.test("readJsonBody rejects oversized chunked-style bodies", async () => {
  const request = new Request("https://example.test", {
    method: "POST",
    body: JSON.stringify({ value: "x".repeat(100) }),
  });
  try {
    await readJsonBody(request, 32);
    throw new Error("expected RequestBodyError");
  } catch (error) {
    assertEquals(error instanceof RequestBodyError, true);
    assertEquals((error as RequestBodyError).status, 413);
  }
});

Deno.test("redactSecrets removes financial and identity values", () => {
  const raw =
    'pin=1234 nin: 12345678901 bvn="10987654321" password=hunter2 Bearer abc.def.ghi';
  const redacted = redactSecrets(raw);
  assertEquals(redacted.includes("1234"), false);
  assertEquals(redacted.includes("12345678901"), false);
  assertEquals(redacted.includes("10987654321"), false);
  assertEquals(redacted.includes("hunter2"), false);
  assertEquals(redacted.includes("abc.def.ghi"), false);
});
