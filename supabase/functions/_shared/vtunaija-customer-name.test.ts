import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { normalizeVerifiedCustomerName } from "./vtunaija-client.ts";

Deno.test("collapses a repeated single customer name", () => {
  assertEquals(normalizeVerifiedCustomerName("Humble Humble"), "Humble");
});

Deno.test("collapses a repeated full customer name", () => {
  assertEquals(normalizeVerifiedCustomerName("John Doe John Doe"), "John Doe");
});

Deno.test("preserves a normal full customer name", () => {
  assertEquals(normalizeVerifiedCustomerName("John Humble Doe"), "John Humble Doe");
});
