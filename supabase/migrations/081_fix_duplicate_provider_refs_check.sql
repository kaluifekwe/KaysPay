-- The financial-integrity monitor's "duplicate provider references" check
-- (migration 061) counted ANY two transactions sharing a vtu_order_id as
-- suspicious. That's true for real provider purchases (airtime/data/bill/
-- exam_pin/esim/foreign_number), where a repeated order id could mean a
-- provider order got processed/credited twice — but complete_service_
-- transaction() (migration 005) is a generic RPC used by EVERY service
-- type, including BVN/NIN verification, which legitimately stores an
-- identifier tied to the BVN/NIN itself in that same column. Re-verifying
-- the same BVN/NIN on a later day (completely normal) reuses that
-- identifier and always false-positived here — confirmed via a real
-- [CRITICAL] alert traced to a tester re-checking the same BVN/NIN across
-- several test runs, no money affected.
--
-- Scope the check to only the real purchase types, where a genuine
-- duplicate provider order is actually meaningful.
CREATE OR REPLACE FUNCTION public.collect_financial_integrity_metrics()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'negative_wallets',(SELECT count(*) FROM public.wallets WHERE balance<0 OR locked_amount<0 OR locked_amount>balance),
    'stuck_vtu',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('airtime','data','bill','exam_pin') AND created_at<now()-INTERVAL '20 minutes'),
    'stuck_foreign_numbers',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type='foreign_number' AND created_at<now()-INTERVAL '30 minutes'),
    'stuck_identity',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('nin_validation','nin_name_modification','nin_phone_modification','nin_address_modification') AND created_at<now()-INTERVAL '72 hours'),
    'duplicate_provider_refs',(SELECT count(*) FROM (SELECT vtu_order_id FROM public.transactions WHERE vtu_order_id IS NOT NULL AND type IN ('airtime','data','bill','exam_pin','esim','foreign_number') AND created_at>now()-INTERVAL '30 days' GROUP BY vtu_order_id HAVING count(*)>1) d),
    'pending_total',(SELECT count(*) FROM public.transactions WHERE status='pending'),
    'completed_24h',(SELECT count(*) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'failed_24h',(SELECT count(*) FROM public.transactions WHERE status='failed' AND created_at>now()-INTERVAL '24 hours'),
    'refunded_24h',(SELECT count(*) FROM public.transactions WHERE status='refunded' AND created_at>now()-INTERVAL '24 hours'),
    'volume_kobo_24h',(SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'burst_accounts',(SELECT count(*) FROM (SELECT user_id FROM public.transactions WHERE created_at>now()-INTERVAL '1 hour' GROUP BY user_id HAVING count(*)>50) b)
  )
$$;
