import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.168.0/testing/asserts.ts";
import { profileChangeCodeEmail } from "./email-template.ts";

Deno.test("profile change email names the exact escaped destination", () => {
  const message = profileChangeCodeEmail("email address", "new+test@example.com<script>", "123456");

  assertStringIncludes(message.html, "new+test@example.com&lt;script&gt;");
  assertEquals(message.html.includes("<script>"), false);
  assertStringIncludes(message.text, "new+test@example.com<script>");
  assertStringIncludes(message.text, "123456");
});
