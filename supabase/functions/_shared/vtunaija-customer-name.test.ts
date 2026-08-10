import { assertEquals } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import {
  normalizeCableTVSmartcardVerification,
  normalizeVerifiedCustomerName,
} from "./vtunaija-client.ts";

Deno.test("collapses a repeated single customer name", () => {
  assertEquals(normalizeVerifiedCustomerName("Humble Humble"), "Humble");
});

Deno.test("collapses a repeated full customer name", () => {
  assertEquals(normalizeVerifiedCustomerName("John Doe John Doe"), "John Doe");
});

Deno.test("preserves a normal full customer name", () => {
  assertEquals(normalizeVerifiedCustomerName("John Humble Doe"), "John Humble Doe");
});

Deno.test("reads cable account details from an object", () => {
  const result = normalizeCableTVSmartcardVerification({
    Customer_Name: "Humble Humble",
    Full_Details: {
      Status: "SUSPENDED",
      Due_Date: "November 24th, 2026",
      Current_Bouquet: "DStv Yanga",
      Renewal_Amount: 6000,
    },
  });
  assertEquals(result.customerName, "Humble");
  assertEquals(result.accountStatus, "SUSPENDED");
  assertEquals(result.dueDate, "November 24th, 2026");
  assertEquals(result.currentBouquet, "DStv Yanga");
  assertEquals(result.renewalAmount, 6000);
});

Deno.test("reads cable account details from a JSON string", () => {
  const result = normalizeCableTVSmartcardVerification({
    name: "Humble Humble",
    Full_Details: JSON.stringify({
      status: "ACTIVE",
      due_date: "December 2nd, 2026",
      current_bouquet: "GOtv Jinja",
      renewal_amount: "3900",
    }),
  });
  assertEquals(result.customerName, "Humble");
  assertEquals(result.accountStatus, "ACTIVE");
  assertEquals(result.dueDate, "December 2nd, 2026");
  assertEquals(result.currentBouquet, "GOtv Jinja");
  assertEquals(result.renewalAmount, 3900);
});

Deno.test("reads cable account details from provider key-value text", () => {
  const result = normalizeCableTVSmartcardVerification({
    Customer_Name: "Humble Humble",
    Full_Details: `'Status':'SUSPENDED','Due_Date':'November 24th, 2026','Current_Bouquet':'GOtv Jinja N3,900','Renewal_Amount':'3900'`,
  });
  assertEquals(result.accountStatus, "SUSPENDED");
  assertEquals(result.dueDate, "November 24th, 2026");
  assertEquals(result.currentBouquet, "GOtv Jinja N3,900");
  assertEquals(result.renewalAmount, 3900);
});
