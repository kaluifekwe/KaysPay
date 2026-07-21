-- 051_push_tokens.sql
--
-- Device push tokens + the cron that delivers pending notifications as push
-- notifications via the Expo Push API (see the notifications-push function).

CREATE TABLE IF NOT EXISTS public.push_tokens (
  token      TEXT PRIMARY KEY,          -- Expo push token (unique per device)
  user_id    UUID NOT NULL,
  platform   TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_push_tokens_user ON public.push_tokens (user_id);

-- Server-only writes. Clients register via the RPC below; the notifications-
-- push function (service role) reads all tokens to send.
ALTER TABLE public.push_tokens ENABLE ROW LEVEL SECURITY;
REVOKE INSERT, UPDATE, DELETE ON public.push_tokens FROM anon, authenticated;

-- Register/refresh the caller's device token. ON CONFLICT reassigns the token
-- to the current user, so a device that switches accounts is handled cleanly.
CREATE OR REPLACE FUNCTION public.register_push_token(p_token TEXT, p_platform TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF p_token IS NULL OR length(p_token) = 0 THEN RETURN; END IF;
  INSERT INTO push_tokens (token, user_id, platform, updated_at)
  VALUES (p_token, auth.uid(), p_platform, now())
  ON CONFLICT (token)
  DO UPDATE SET user_id = auth.uid(), platform = EXCLUDED.platform, updated_at = now();
END; $$;
GRANT EXECUTE ON FUNCTION public.register_push_token(TEXT, TEXT) TO authenticated;

-- Deliver pending notifications as push, every minute. Same net.http_post +
-- anon-JWT + x-cron-secret pattern as the other crons (migration 043).
DO $$
BEGIN
  PERFORM cron.unschedule('notifications-push');
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

SELECT cron.schedule(
  'notifications-push',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/notifications-push',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 30000
  );
  $$
);
