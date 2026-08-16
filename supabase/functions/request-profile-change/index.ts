import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import {
  adminClient,
  consumeAuthToken,
  enforceRateLimit,
  getAuthUser,
  isDeviceSessionAllowed,
  readJsonBody,
  RequestBodyError,
} from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { profileChangeCodeEmail } from "../_shared/email-template.ts";

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

const NG_PHONE_RE = /^0\d{10}$/;

function normalizePhone(raw: string): string {
  let phone = raw.replace(/[^\d]/g, "");
  if (phone.startsWith("234") && phone.length === 13) {
    phone = "0" + phone.slice(3);
  }
  return phone;
}

// Step 1 of the phone/email change flow (see migration 077). Requires the
// PIN/biometric step-up token on every call — a valid JWT alone is not
// enough to touch these fields, same discipline as every money-moving
// function. Changing an EXISTING phone or email additionally requires an
// OTP emailed to the account's current address before request-profile-change's
// sibling, confirm-profile-change, will apply it. Adding a phone when none
// exists yet applies immediately here, since there's no existing number to
// protect.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  const user = await getAuthUser(req);
  if (!user) return json({ success: false, error: "Unauthorized" }, 401);
  if (!user.email) return json({ success: false, error: "No email on this account" }, 400);

  const supabase = adminClient();

  if (!(await isDeviceSessionAllowed(req, supabase, user.id))) {
    return json({ success: false, error: "This device session has been revoked. Please log in again." }, 401);
  }

  let body: { field?: string; new_value?: string; auth_token?: string };
  try {
    body = await readJsonBody(req, 2048);
  } catch (error) {
    const e = error instanceof RequestBodyError ? error : new RequestBodyError(400, "Invalid request body");
    return json({ success: false, error: e.message }, e.status);
  }

  const field = body.field === "email" ? "email" : body.field === "phone" ? "phone" : null;
  if (!field) return json({ success: false, error: "Invalid field" }, 400);

  const authed = await consumeAuthToken(supabase, user.id, body.auth_token);
  if (!authed) return json({ success: false, error: "Please re-authorize with your PIN and try again." }, 401);

  const rate = await enforceRateLimit(supabase, "request_profile_change", user.id, 5, 3600, user.id);
  if (!rate.allowed) {
    return json({ success: false, error: "Too many requests. Please wait and try again." }, 429);
  }

  let newValue: string;
  if (field === "email") {
    const lower = String(body.new_value || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(lower)) {
      return json({ success: false, error: "Enter a valid email address" }, 400);
    }
    if (lower === user.email.toLowerCase()) {
      return json({ success: false, error: "That's already your current email" }, 400);
    }
    const { data: existingUserId } = await supabase.rpc("get_user_id_by_email", { p_email: lower });
    if (existingUserId) return json({ success: false, error: "That email is already in use" }, 400);
    newValue = lower;
  } else {
    const phone = normalizePhone(String(body.new_value || ""));
    if (!NG_PHONE_RE.test(phone)) {
      return json({ success: false, error: "Enter a valid Nigerian phone number" }, 400);
    }
    newValue = phone;
  }

  // Adding a phone number when none is currently on file: nothing to
  // protect against hijacking, so apply immediately without an OTP round
  // trip. This is the ONLY case that skips OTP — changing an already-set
  // phone, or an email (which always exists), always requires one below.
  if (field === "phone") {
    const meta = (user.user_metadata || {}) as Record<string, unknown>;
    const currentPhone = String(user.phone || meta.phone || meta.phone_number || "").trim();
    if (!currentPhone) {
      const { error: updateError } = await supabase.auth.admin.updateUserById(user.id, {
        user_metadata: { ...meta, phone: newValue },
      });
      if (updateError) {
        return json({ success: false, error: updateError.message || "Could not save your phone number." }, 500);
      }
      return json({ success: true, applied: true, new_value: newValue });
    }
  }

  if (!isResendConfigured()) return json({ success: false, error: "Email service not configured yet" }, 500);

  const purpose = field === "email" ? "change_email" : "change_phone";
  const code = generateCode();
  const { data: createResult, error: createError } = await supabase.rpc("create_profile_change_verification", {
    p_user_id: user.id,
    p_field: field,
    p_new_value: newValue,
    p_purpose: purpose,
    p_code: code,
  });
  if (createError) return json({ success: false, error: "Could not start verification. Please try again." }, 500);

  if (!createResult?.ok) {
    if (createResult?.error === "RATE_LIMITED") {
      return json({ success: false, error: "Please wait a moment before requesting another code." });
    }
    if (createResult?.error === "DAILY_LIMIT_REACHED") {
      return json({ success: false, error: "Too many attempts today. Please try again tomorrow." });
    }
    return json({ success: false, error: "Could not start verification. Please try again." }, 500);
  }

  const verificationCodeId = createResult.verification_code_id;
  if (typeof verificationCodeId !== "string" || !verificationCodeId) {
    return json({ success: false, error: "Could not start verification. Please try again." }, 500);
  }

  const fieldLabel = field === "email" ? "email address" : "phone number";
  const { subject, html, text } = profileChangeCodeEmail(fieldLabel, newValue, code);
  const sendResult = await sendEmail(user.email, subject, html, { text });
  if (!sendResult.ok) {
    console.error("request-profile-change: Resend send failed:", sendResult.error);
    await supabase.rpc("cancel_profile_change_verification", {
      p_user_id: user.id,
      p_verification_code_id: verificationCodeId,
    });
    return json({ success: false, error: "Could not send the verification email. Please try again." }, 500);
  }

  return json({
    success: true,
    applied: false,
    sent_to: user.email.replace(/^(.{2}).*(@.*)$/, "$1***$2"),
  });
});
