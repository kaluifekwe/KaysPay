-- Kay's Pay: scheduled execution of due payrolls
-- =====================================================================
-- Same pattern as the reconcile crons (016/019/027/028). Runs every 5
-- minutes; payroll-execute claims due scheduled_payrolls and sends them.
-- =====================================================================

SELECT cron.schedule(
  'payroll-execute-due',
  '*/5 * * * *',
  $$
  SELECT net.http_post(
    url := 'https://xswlrzhtxrzugoxdonjc.supabase.co/functions/v1/payroll-execute',
    headers := jsonb_build_object(
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhzd2xyemh0eHJ6dWdveGRvbmpjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI1MTM3NjcsImV4cCI6MjA5ODA4OTc2N30.i5OKPZC3swGLpiadEdCHuqOhZJWNlyg4FAA-Ndu4uL0',
      'Content-Type', 'application/json'
    ),
    body := '{}'::jsonb
  );
  $$
);
