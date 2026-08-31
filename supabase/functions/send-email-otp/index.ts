import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { otpEmail } from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

function generateCode(): string {
  // 6 secure-random digits (000000�?99999, left-padded).
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  return String(bytes[0] % 1_000_000).padStart(6, "0");
}

// Only ever verifies the signup email itself �?email/phone are fixed at
// signup and never user-editable afterward (owner decision, 2026-07-06).
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!isResendConfigured()) return json({ success: false, error: "Email service not configured yet" }, 500);

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);
  if (!user.email) return json({ success: false, error: "No email on this account" }, 400);

  const supabase = adminClient();
  const code = generateCode();

  const { data: createResult, error: createError } = await supabase.rpc("create_email_verification_code", {
    p_user_id: user.id,
    p_purpose: "signup",
    p_target: user.email,
    p_code: code,
  });

  if (createError) return json({ success: false, error: "Could not start verification. Please try again." }, 500);

  if (!createResult?.ok) {
    if (createResult?.error === "RATE_LIMITED") {
      // Machine-readable code alongside the message. This one is not really a
      // failure: it means a code was issued in the last 60 seconds and is
      // still valid and sitting in the customer's inbox. The app needs to
      // tell it apart from a genuine send failure so it can say "enter the
      // code we already sent" and show the input, instead of an error screen
      // that hides the very field they need.
      return json({
        success: false,
        code: "RATE_LIMITED",
        error: "Please wait a moment before requesting another code.",
      });
    }
    if (createResult?.error === "DAILY_LIMIT_REACHED") {
      return json({ success: false, error: "Too many attempts today. Please try again tomorrow." });
    }
    return json({ success: false, error: "Could not start verification. Please try again." }, 500);
  }

  const { subject, html, text } = otpEmail(code);
  const sendResult = await sendEmail(user.email, subject, html, { text });
  if (!sendResult.ok) {
    // Surface the real Resend error in the function logs �?otherwise a
    // domain-not-verified / test-mode / bad-key rejection is invisible and
    // looks like a generic outage from the client's side.
    console.error("send-email-otp: Resend send failed:", sendResult.error);
    return json({ success: false, error: "Could not send the verification email. Please try again." }, 500);
  }

  return json({ success: true, sent_to: user.email.replace(/^(.{2}).*(@.*)$/, "$1***$2") });
});
