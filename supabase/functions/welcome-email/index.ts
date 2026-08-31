import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { adminClient, verifyCronSecret } from "../_shared/auth.ts";
import { isResendConfigured, sendEmail } from "../_shared/resend-client.ts";
import { welcomeEmail } from "../_shared/email-template.ts";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(), "Content-Type": "application/json" },
  });
}

// Sent "from the founder" â€?a friendly From name on the verified sending
// domain, with replies routed to a real inbox (support@ can't receive mail
// yet, so replies go to the owner's Gmail for now â€?owner-approved 2026-07-23).
const WELCOME_FROM = "Kalu Ifekwe <no-reply@kayspay.com.ng>";
const WELCOME_REPLY_TO = "kaluifekwe6@gmail.com";

function firstNameOf(fullName: string | null): string {
  if (!fullName) return "";
  return fullName.trim().split(/\s+/)[0] || "";
}

// Cron-only (every 5 min, see migration 052). Gated by x-cron-secret â€?the
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
  // omits the invite block rather than failing the send â€?the welcome email
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

  return json({ success: true, claimed: rows.length, sent, failed });
});
