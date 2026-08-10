import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { vtuNgOutcome } from "./vtu-client.ts";

Deno.test("VTU.ng status mapping never treats unknown as failure", () => {
  assertEquals(vtuNgOutcome("completed-api"), "success");
  assertEquals(vtuNgOutcome("processing-api"), "pending");
  assertEquals(vtuNgOutcome("failed-api"), "failed");
  assertEquals(vtuNgOutcome("temporary-provider-state"), "unknown");
  assertEquals(vtuNgOutcome(null), "unknown");
});
