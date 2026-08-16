import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { isBootstrapOperator } from "./admin-bootstrap.ts";

Deno.test("admin bootstrap fails closed without an allowlist", () => {
  assertEquals(isBootstrapOperator("operator-id", undefined), false);
  assertEquals(isBootstrapOperator("operator-id", ""), false);
});

Deno.test("admin bootstrap accepts only an exact allowlisted user id", () => {
  assertEquals(isBootstrapOperator("operator-id", "other-id, operator-id"), true);
  assertEquals(isBootstrapOperator("operator", "operator-id"), false);
});
