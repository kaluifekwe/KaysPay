-- Date-range-aware dashboard report, replacing collect_admin_dashboard_stats
-- (087) as the admin Dashboard's data source — that one only ever computed
-- fixed 24h/7d windows and had no service breakdown. Left in place
-- unreferenced rather than dropped (this codebase's usual rollback
-- convention). collect_financial_integrity_metrics() (061) is untouched —
-- it's polled by the automated monitoring/alerting cron on a fixed 24h
-- window and must keep behaving exactly as it does today.
--
-- 'orders_refunded_in_range' deliberately does NOT check status = 'refunded'
-- — nothing in this codebase ever sets that literal status. Every real
-- refund (refund_service_transaction / refund_completed_service_transaction,
-- see migrations 008 and 020) sets status = 'failed' with
-- metadata.refunded = true instead. Getting this right here (unlike the
-- pre-existing collect_financial_integrity_metrics(), which is out of
-- scope to touch) means "failed" only ever means a genuine provider
-- failure, not a refund being double-counted as one.
CREATE FUNCTION public.admin_dashboard_report(p_start TIMESTAMPTZ, p_end TIMESTAMPTZ)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM public.users),
    'new_users_in_range', (SELECT count(*) FROM public.users WHERE created_at >= p_start AND created_at < p_end),
    'orders_in_range', (SELECT count(*) FROM public.transactions WHERE created_at >= p_start AND created_at < p_end),
    'orders_completed_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end),
    'orders_failed_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'failed' AND COALESCE(metadata->>'refunded','') <> 'true' AND created_at >= p_start AND created_at < p_end),
    'orders_refunded_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'failed' AND metadata->>'refunded' = 'true' AND created_at >= p_start AND created_at < p_end),
    'volume_kobo_in_range', (SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end),
    'services', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('type', s.type, 'order_count', s.cnt, 'volume_kobo', s.vol) ORDER BY s.vol DESC), '[]'::jsonb)
      FROM (
        SELECT type, count(*) AS cnt, sum(amount_ngn) AS vol
        FROM public.transactions
        WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end
        GROUP BY type
      ) s
    )
  )
$$;
REVOKE EXECUTE ON FUNCTION public.admin_dashboard_report(TIMESTAMPTZ, TIMESTAMPTZ) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_dashboard_report(TIMESTAMPTZ, TIMESTAMPTZ) TO service_role;
