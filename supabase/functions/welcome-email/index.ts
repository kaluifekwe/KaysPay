import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, verifyCronSecret } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import {
  fundedNotPurchasedReminderEmail, kycReminderEmail, kycVerifiedNotFundedReminderEmail,
  pinNotSetReminderEmail, welcomeEmail,
} from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Sent "from the founder" �?a friendly From name on the verified sending
// domain, with replies routed to a real inbox (support@ can't receive mail
// yet, so replies go to the owner's Gmail for now �?owner-approved 2026-07-23).
const WELCOME_FROM = "Kalu Ifekwe <no-reply@kayspay.com.ng>";
const WELCOME_REPLY_TO = "kaluifekwe6@gmail.com";

function firstNameOf(fullName: string | null): string {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0] || "";
}

// Cron-only (every 5 min, see migration 052). Gated by x-cron-secret �?the
// anon key alone isn't real protection since it's bundled in the app.
serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  if (!verifyCronSecret(req)) return json({ success: false, error: "Forbidden" }, 403);
  if (!isResendConfigured()) return json({ success: false, error: "Email service not configured" }, 500);

  const supabase = adminClient();

  const { data: due, error } = await supabase.rpc("claim_due_welcome_emails", { p_limit: 50 });
  if (error) return json({ success: false, error: "Could not load pending welcomes" }, 500);

  // Owner-editable WhatsApp support group (app_settings, migration 132).
  // Read once per run, not per email. A missing or invalid value simply
  // omits the invite block rather than failing the send �?the welcome email
  // matters more than the invite.
  const { data: groupSetting } = await supabase
    .from("app_settings")
    .select("value")
    .eq("key", "support_whatsapp_group_url")
    .maybeSingle();
  const whatsappGroupUrl = groupSetting?.value ?? null;

  const rows: { user_id: string; email: string; full_name: string | null }[] = due || [];
  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    const { subject, html, text } = welcomeEmail(firstNameOf(row.full_name), whatsappGroupUrl);
    const result = await sendEmail(row.email, subject, html, { from: WELCOME_FROM, replyTo: WELCOME_REPLY_TO, text });
    if (result.ok) {
      sent++;
    } else {
      failed++;
      // Surface the real Resend error so a domain/test-mode/key problem is
      // visible in the logs instead of just an incrementing failure count.
      console.error("welcome-email: Resend send failed for", row.email, ":", result.error);
      // Release the claim so this user is retried on the next run instead of
      // being silently skipped forever.
      await supabase.rpc("unmark_welcome_sent", { p_user_id: row.user_id });
    }
  }

  // Same run also handles the KYC-completion reminder -- transactional,
  // same "about the customer's own incomplete signup" category as the
  // welcome email above, folded into this function rather than a new one
  // since the project is at its 100-function plan cap. Reuses this
  // function's existing cron trigger (every 5 min); a failure here must
  // never affect the welcome-email loop's own success/failure, so it's
  // wrapped independently.
  let kycClaimed = 0, kycSent = 0, kycFailed = 0;
  try {
    const { data: kycDue, error: kycError } = await supabase.rpc("claim_due_kyc_reminders", { p_limit: 50 });
    if (!kycError) {
      const kycRows: { user_id: string; email: string; full_name: string | null }[] = kycDue || [];
      kycClaimed = kycRows.length;
      for (const row of kycRows) {
        const { subject, html, text } = kycReminderEmail(firstNameOf(row.full_name));
        const result = await sendEmail(row.email, subject, html, { from: WELCOME_FROM, replyTo: WELCOME_REPLY_TO, text });
        if (result.ok) {
          kycSent++;
        } else {
          kycFailed++;
          console.error("welcome-email: kyc-reminder send failed for", row.email, ":", result.error);
          await supabase.rpc("unmark_kyc_reminder_sent", { p_user_id: row.user_id });
        }
      }
    } else {
      console.error("welcome-email: could not load pending kyc reminders:", kycError.message);
    }
  } catch (e) {
    console.error("welcome-email: kyc-reminder loop threw:", e instanceof Error ? e.message : String(e));
  }

  // Generalized lifecycle reminders (migration 197) -- pin_not_set,
  // kyc_completed_not_funded, funded_not_purchased. Owner-paused by default
  // via app_settings; small per-stage batch (3 each = up to 9/tick) so a
  // backlog can never eat a whole day's shared 100/day Resend budget in one
  // run. Stops early the moment Resend itself signals a rate limit --
  // reacting to the real API rather than tracking a local quota guess --
  // and releases the rest of that tick's claims to retry next time.
  let lifecycleClaimed = 0, lifecycleSent = 0, lifecycleFailed = 0, lifecycleThrottled = false;
  try {
    const { data: enabledSetting } = await supabase
      .from("app_settings").select("value").eq("key", "lifecycle_reminders_enabled").maybeSingle();
    if (enabledSetting?.value === "true") {
      const { data: lifecycleDue, error: lifecycleError } = await supabase.rpc("claim_due_lifecycle_reminders", { p_limit_per_stage: 3 });
      if (!lifecycleError) {
        const lifecycleRows: { id: string; user_id: string; email: string; full_name: string | null; stage: string; attempt_number: number }[] = lifecycleDue || [];
        lifecycleClaimed = lifecycleRows.length;
        for (const row of lifecycleRows) {
          if (lifecycleThrottled) {
            await supabase.rpc("release_lifecycle_reminder", { p_id: row.id });
            continue;
          }
          const template = row.stage === "pin_not_set" ? pinNotSetReminderEmail
            : row.stage === "kyc_completed_not_funded" ? kycVerifiedNotFundedReminderEmail
            : fundedNotPurchasedReminderEmail;
          const { subject, html, text } = template(firstNameOf(row.full_name));
          const result = await sendEmail(row.email, subject, html, { from: WELCOME_FROM, replyTo: WELCOME_REPLY_TO, text });
          if (result.ok) {
            lifecycleSent++;
            if (result.id) await supabase.rpc("mark_lifecycle_reminder_sent", { p_id: row.id, p_provider_message_id: result.id });
          } else {
            lifecycleFailed++;
            console.error("welcome-email: lifecycle-reminder send failed for", row.email, ":", result.error);
            await supabase.rpc("release_lifecycle_reminder", { p_id: row.id });
            // Resend's real error type for hitting the shared cap is
            // "daily_quota_exceeded" / "monthly_quota_exceeded" (confirmed
            // via a live probe 2026-09-03) -- "rate_limit_exceeded" covers
            // its separate per-second API limit. Neither literally says
            // "rate limit", so a bare /rate.?limit/i check here would have
            // silently never triggered.
            if (/quota_exceeded|rate_limit_exceeded/.test(result.error || "")) lifecycleThrottled = true;
          }
        }
      } else {
        console.error("welcome-email: could not load pending lifecycle reminders:", lifecycleError.message);
      }
    }
  } catch (e) {
    console.error("welcome-email: lifecycle-reminder loop threw:", e instanceof Error ? e.message : String(e));
  }

  return json({
    success: true, claimed: rows.length, sent, failed,
    kyc_reminders: { claimed: kycClaimed, sent: kycSent, failed: kycFailed },
    lifecycle_reminders: { claimed: lifecycleClaimed, sent: lifecycleSent, failed: lifecycleFailed, throttled: lifecycleThrottled },
  });
});
