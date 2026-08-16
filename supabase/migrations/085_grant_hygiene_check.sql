-- Recurring self-check (item 2 of the 2026-08-06 security audit follow-up):
-- catches the exact class of bug that produced this session's two critical
-- findings — a SECURITY DEFINER function taking a raw p_user_id, callable
-- by anon/authenticated because its REVOKE only said `FROM PUBLIC` instead
-- of `FROM PUBLIC, anon, authenticated`. Adds one more metric to the
-- existing financial-integrity-monitor cron/email pipeline (migration 061)
-- rather than building new infrastructure — same cadence, same alert
-- table, same email.
CREATE OR REPLACE FUNCTION public.collect_financial_integrity_metrics()
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT jsonb_build_object(
    'negative_wallets',(SELECT count(*) FROM public.wallets WHERE balance<0 OR locked_amount<0 OR locked_amount>balance),
    'stuck_vtu',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('airtime','data','bill','exam_pin') AND created_at<now()-INTERVAL '20 minutes'),
    'stuck_foreign_numbers',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type='foreign_number' AND created_at<now()-INTERVAL '30 minutes'),
    'stuck_identity',(SELECT count(*) FROM public.transactions WHERE status='pending' AND type IN ('nin_validation','nin_name_modification','nin_phone_modification','nin_address_modification') AND created_at<now()-INTERVAL '72 hours'),
    'duplicate_provider_refs',(SELECT count(*) FROM (SELECT vtu_order_id FROM public.transactions WHERE vtu_order_id IS NOT NULL AND type IN ('airtime','data','bill','exam_pin','esim','foreign_number') AND created_at>now()-INTERVAL '30 days' GROUP BY vtu_order_id HAVING count(*)>1) d),
    'unsafe_grants',(
      SELECT count(*) FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public' AND p.prosecdef = true
        AND 'p_user_id' = ANY(p.proargnames)
        AND (
          has_function_privilege('anon', p.oid, 'EXECUTE')
          OR has_function_privilege('authenticated', p.oid, 'EXECUTE')
        )
    ),
    'pending_total',(SELECT count(*) FROM public.transactions WHERE status='pending'),
    'completed_24h',(SELECT count(*) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'failed_24h',(SELECT count(*) FROM public.transactions WHERE status='failed' AND created_at>now()-INTERVAL '24 hours'),
    'refunded_24h',(SELECT count(*) FROM public.transactions WHERE status='refunded' AND created_at>now()-INTERVAL '24 hours'),
    'volume_kobo_24h',(SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status='completed' AND created_at>now()-INTERVAL '24 hours'),
    'burst_accounts',(SELECT count(*) FROM (SELECT user_id FROM public.transactions WHERE created_at>now()-INTERVAL '1 hour' GROUP BY user_id HAVING count(*)>50) b)
  )
$$;
