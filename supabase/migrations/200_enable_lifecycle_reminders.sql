-- Owner approved the copy and the admin panel 2026-09-03. Flips the pause
-- switch inserted paused by migration 197. From here, welcome-email's
-- existing 5-minute cron starts claiming and sending real reminders for
-- pin_not_set / kyc_completed_not_funded / funded_not_purchased, small
-- per-stage batches at a time.
UPDATE public.app_settings SET value = 'true', updated_at = now()
WHERE key = 'lifecycle_reminders_enabled';
