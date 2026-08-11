-- Detect a funding reconciliation sweep that runs cleanly but sees nothing.
--
-- Background: the Paystack sweep silently processed zero records for its entire
-- life because Paystack's list-transactions response omits the receiving
-- account number the normalizer demanded. Every run reported success with no
-- error, so all existing signals -- last_run_at, last_error -- looked perfectly
-- healthy while the safety net for missed funding webhooks caught nothing. Any
-- funding webhook that failed to arrive would never have been recovered.
--
-- The existing metrics could not catch this: "it ran" and "it errored" were
-- both fine. What was missing is "it actually looked at something". These
-- columns record that, so a blind sweep is distinguishable from a quiet one.

ALTER TABLE public.funding_reconciliation_state
  ADD COLUMN IF NOT EXISTS last_seen_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_saw_records_at TIMESTAMPTZ;

-- Start the clock now rather than leaving NULL. A NULL would immediately fire
-- the alert for both providers on deploy, since money did move in the last 24
-- hours but no sweep has recorded a sighting yet under the new column. The
-- detector measures forward from here.
UPDATE public.funding_reconciliation_state
   SET last_saw_records_at = now()
 WHERE last_saw_records_at IS NULL;

CREATE OR REPLACE FUNCTION public.collect_financial_integrity_metrics()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'negative_wallets',(SELECT count(*) FROM public.wallets WHERE balance<0 OR locked_amount<0 OR locked_amount>balance),
    'stuck_vtu',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('airtime','data','bill','exam_pin') AND created_at<now()-INTERVAL '20 minutes'),
    'stuck_foreign_numbers',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type='foreign_number' AND created_at<now()-INTERVAL '30 minutes'),
    'stuck_identity',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('nin_validation','nin_name_modification','nin_phone_modification','nin_address_modification') AND created_at<now()-INTERVAL '72 hours'),
    'duplicate_provider_refs',(SELECT count(*) FROM (SELECT vtu_order_id FROM public.transactions WHERE vtu_order_id IS NOT NULL AND type IN ('airtime','data','bill','exam_pin','esim','foreign_number') AND created_at>now()-INTERVAL '30 days' GROUP BY vtu_order_id HAVING count(*)>1) d),
    'unsafe_grants',(SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef AND 'p_user_id'=ANY(p.proargnames) AND (has_function_privilege('anon',p.oid,'EXECUTE') OR has_function_privilege('authenticated',p.oid,'EXECUTE'))),
    'funding_unresolved',(SELECT count(*) FROM public.funding_events WHERE status IN ('received','unmatched','error') AND last_seen_at<now()-INTERVAL '4 minutes'),
    'funding_reconcile_stale',(SELECT count(*) FROM public.funding_reconciliation_state WHERE last_run_at IS NULL OR last_run_at<now()-INTERVAL '15 minutes'),
    'funding_reconcile_errors',(SELECT count(*) FROM public.funding_reconciliation_state WHERE last_error IS NOT NULL),
    -- Money demonstrably moved through a provider in the last 24h, yet that
    -- provider's sweep has not laid eyes on a single record in the same
    -- period. Sweep windows are contiguous (each starts 5 minutes before the
    -- last success), so a healthy sweep necessarily covers the moment any
    -- funding event arrived. Seeing nothing therefore means blind, not quiet.
    'funding_reconcile_blind',(
      SELECT count(*) FROM public.funding_reconciliation_state s
       WHERE EXISTS (SELECT 1 FROM public.funding_events e WHERE e.provider=s.provider AND e.received_at>now()-INTERVAL '24 hours')
         AND (s.last_saw_records_at IS NULL OR s.last_saw_records_at<now()-INTERVAL '24 hours')
    ),
    'pending_total',(SELECT count(*) FROM public.transactions WHERE status='pending'),
    'completed_24h',(SELECT count(*) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'failed_24h',(SELECT count(*) FROM public.transactions WHERE status='failed' AND created_at>now()-INTERVAL '24 hours'),
    'refunded_24h',(SELECT count(*) FROM public.transactions WHERE status='refunded' AND created_at>now()-INTERVAL '24 hours'),
    'volume_kobo_24h',(SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'burst_accounts',(SELECT count(*) FROM (SELECT user_id FROM public.transactions WHERE created_at>now()-INTERVAL '1 hour' GROUP BY user_id HAVING count(*)>50) b),
    'repeated_pin_lockouts',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='transaction_pin_lockout' AND created_at>now()-INTERVAL '24 hours' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=3) s),
    'repeated_pin_resets',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='transaction_pin_reset' AND created_at>now()-INTERVAL '24 hours' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=2) s),
    'repeated_admin_denials',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='admin_auth_denied' AND created_at>now()-INTERVAL '15 minutes' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=5) s),
    'shared_device_accounts',(SELECT count(*) FROM (SELECT metadata->>'device_hash' AS device_hash FROM public.security_events WHERE event_type='device_session_registered' AND created_at>now()-INTERVAL '30 days' AND metadata ? 'device_hash' GROUP BY metadata->>'device_hash' HAVING count(DISTINCT user_id)>=3) s),
    'excessive_new_devices',(SELECT count(*) FROM (SELECT user_id FROM public.security_events WHERE event_type='device_session_registered' AND created_at>now()-INTERVAL '24 hours' AND user_id IS NOT NULL GROUP BY user_id HAVING count(*)>=5) s)
  )
$$;
