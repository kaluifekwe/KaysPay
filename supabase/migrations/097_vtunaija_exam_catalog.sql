-- Guarded live catalogue for VTUnaija Exam PIN prices. Unlike data, the
-- provider exposes these prices only on its public pricing page, so the Edge
-- Function validates the complete six-row snapshot before writing anything.
CREATE TABLE IF NOT EXISTS public.vtunaija_exam_catalog (
  id TEXT PRIMARY KEY,
  exam_code INTEGER NOT NULL UNIQUE CHECK (exam_code BETWEEN 1 AND 6),
  name TEXT NOT NULL,
  basic_kobo BIGINT NOT NULL CHECK (basic_kobo > 0),
  premium_kobo BIGINT NOT NULL CHECK (premium_kobo > 0),
  customer_kobo BIGINT NOT NULL CHECK (customer_kobo > 0),
  previous_customer_kobo BIGINT,
  available BOOLEAN NOT NULL DEFAULT true,
  requires_review BOOLEAN NOT NULL DEFAULT false,
  provider_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.vtunaija_exam_catalog
  (id, exam_code, name, basic_kobo, premium_kobo, customer_kobo)
VALUES
  ('waec', 1, 'WAEC Exam PIN', 515000, 508000, 508000),
  ('neco', 2, 'NECO Exam PIN', 235000, 209000, 209000),
  ('nabteb', 3, 'NABTEB Exam PIN', 90000, 88000, 88000),
  ('jamb', 4, 'JAMB Exam PIN', 1500000, 1500000, 1500000),
  ('waec-registration', 5, 'WAEC Registration PIN', 1500000, 1500000, 1500000),
  ('nbais', 6, 'NBAIS Exam PIN', 115000, 105000, 105000)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.vtunaija_exam_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtunaija_exam_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vtunaija_exam_catalog TO service_role;

SELECT cron.unschedule('vtunaija-exam-catalog-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtunaija-exam-catalog-sync');

SELECT cron.schedule(
  'vtunaija-exam-catalog-sync',
  '*/15 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/vtunaija-exam-catalog',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json',
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'cron_secret')
    ),
    body := '{"refresh":true}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
