import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  enforceRateLimit,
  getAuthUser,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Only ever verifies the signup email itself â€?see send-email-otp.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);
  if (!user.email) {
    return json({ success: false, error: "No email on this account" }, 400);
  }

  let body: any;
  try {
    body = await readJsonBody(req, 2048);
  } catch (error) {
    const e = error instanceof RequestBodyError
      ? error
      : new RequestBodyError(400, "Invalid request body");
    return json({ success: false, error: e.message }, e.status);
  }

  const code = String(body?.code || "").trim();
  if (!/^\d{6}$/.test(code)) {
    return json({ success: false, error: "Enter the 6-digit code" }, 400);
  }

  const supabase = adminClient();

  const rate = await enforceRateLimit(
    supabase,
    "verify_email_otp",
    user.id,
    10,
    600,
    user.id,
  );
  if (!rate.allowed) {
    return json({
      success: false,
      error: "Too many verification attempts. Please wait and try again.",
      retry_after_seconds: rate.retryAfterSeconds,
    }, 429);
  }

  const { data: result, error: verifyError } = await supabase.rpc(
    "verify_email_verification_code",
    {
      p_user_id: user.id,
      p_purpose: "signup",
      p_target: user.email,
      p_code: code,
    },
  );

  if (verifyError) {
    return json({
      success: false,
      error: "Could not verify code. Please try again.",
    }, 500);
  }

  if (!result?.valid) {
    if (result?.error === "EXPIRED") {
      return json({
        success: false,
        error: "This code has expired. Request a new one.",
      });
    }
    if (result?.error === "NOT_FOUND") {
      return json({
        success: false,
        error: "Request a new code and try again.",
      });
    }
    if (result?.locked) {
      return json({
        success: false,
        error: "Too many wrong attempts. Request a new code.",
      });
    }
    return json({
      success: false,
      error: "Incorrect code. Please try again.",
      attempts_remaining: result?.attempts_remaining,
    });
  }

  // Code confirmed â€?never let the client apply its own "verified" state;
  // this is the only place that does.
  //
  // Use an APP-OWNED key (email_otp_verified), NOT `email_verified`: Supabase
  // Auth itself stamps `email_verified: true` in user_metadata at signup when
  // "Confirm email" is off, so gating on it means the app thinks every new
  // signup is already verified and skips this whole flow (no OTP is ever sent).
  // email_otp_verified is set ONLY here, so it reliably means "passed our code".
  await supabase.auth.admin.updateUserById(user.id, {
    user_metadata: {
      ...user.user_metadata,
      email_verified: true,
      email_otp_verified: true,
    },
  });

  return json({ success: true });
});
