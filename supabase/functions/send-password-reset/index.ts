import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { passwordResetEmail } from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function generateCode(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

// Generic reply used for EVERY outcome (unknown email, rate-limited, sent).
// Never reveal whether an account exists for the address — that would turn
// this endpoint into an email-enumeration oracle.
const GENERIC = { success: true, message: "If an account exists for that email, we've sent a 6-digit reset code." };

// Unauthenticated: a user who forgot their password has no session. Called
// with the app's anon key (satisfies verify_jwt). Identity is the email in
// the body, verified only later by the reset code — never trusted here.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isResendConfigured()) return json({ success: false, error: "Email service not configured yet" }, 500);

  let body: { email?: string };
  try {
    body = await req.json();
  } catch {
    return json({ success: false, error: "Invalid request body" }, 400);
  }

  const email = String(body?.email || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return json({ success: false, error: "Enter a valid email address" }, 400);
  }

  const supabase = adminClient();

  const { data: userId, error: lookupError } = await supabase.rpc("get_user_id_by_email", { p_email: email });
  // On a genuine server error, fail closed but generically.
  if (lookupError) return json(GENERIC);
  // No account for this email — return the same generic success, send nothing.
  if (!userId) return json(GENERIC);

  const code = generateCode();
  const { data: createResult, error: createError } = await supabase.rpc("create_email_verification_code", {
    p_user_id: userId,
    p_purpose: "password_reset",
    p_target: email,
    p_code: code,
  });

  // Rate-limited / capped / errored: still generic success, so timing and
  // response don't leak account existence. The user simply doesn't get a new
  // code until the 60s cooldown passes.
  if (createError || !createResult?.ok) return json(GENERIC);

  const { subject, html, text } = passwordResetEmail(code);
  await sendEmail(email, subject, html, { text });

  return json(GENERIC);
});
