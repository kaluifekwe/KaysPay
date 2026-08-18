-- Adds the WhatsApp support-group invite link as an owner-editable setting
-- (owner-approved 2026-08-18). Used by the founder welcome email, which now
-- invites new users to the group — see _shared/email-template.ts.
--
-- Editable rather than hardcoded for the same reason as the support number:
-- a group's invite code changes if the group is ever recreated or its link
-- reset, and that must not require a code change and redeploy.
ALTER TABLE public.app_settings DROP CONSTRAINT IF EXISTS app_settings_key_check;
ALTER TABLE public.app_settings ADD CONSTRAINT app_settings_key_check
  CHECK (key IN ('support_whatsapp_number', 'support_whatsapp_group_url'));

-- Stored WITHOUT WhatsApp's copy-source tracking params (?s=cl&p=a&ilr=4) —
-- the invite is resolved entirely from the code in the path, and a bare URL
-- avoids &-escaping problems when it is dropped into email HTML.
INSERT INTO public.app_settings(key, value)
VALUES ('support_whatsapp_group_url', 'https://chat.whatsapp.com/HIv0RHiLFXy7lWDLAkSnB3')
ON CONFLICT (key) DO NOTHING;
