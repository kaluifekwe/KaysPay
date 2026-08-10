import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { hasSeparatedFailureConfirmation } from "./provider-failure-confirmation.ts";

Deno.test("requires the same failure status twice with time separation", () => {
  const now = Date.parse("2026-08-10T12:01:00.000Z");
  assertEquals(hasSeparatedFailureConfirmation(null, "failed", now), false);
  assertEquals(hasSeparatedFailureConfirmation({ at: "2026-08-10T12:00:30.000Z", status: "failed" }, "failed", now), true);
  assertEquals(hasSeparatedFailureConfirmation({ at: "2026-08-10T12:00:30.000Z", status: "declined" }, "failed", now), false);
  assertEquals(hasSeparatedFailureConfirmation({ at: "2026-08-10T12:00:50.000Z", status: "failed" }, "failed", now), false);
});
