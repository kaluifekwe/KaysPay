-- Data source for the admin "Share" page (migration 182): a branded,
-- screenshot-ready stats card + recent-activity feed the owner posts to
-- social media. Deliberately its OWN function rather than reusing
-- admin_dashboard_report (089) or admin-transactions -- both of those
-- return per-user/per-transaction identifying data (name, phone, recipient,
-- order_ref), which is fine for an internal admin view but must never be
-- fetched at all for something meant to leave the building. 'recent' below
-- returns ONLY type, amount, and timestamp -- no user_id, no recipient, no
-- order_ref -- so there is nothing to accidentally render even if the UI
-- changes later.
CREATE FUNCTION public.admin_share_report(p_recent_limit INT DEFAULT 8)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM public.users),
    'completed_transactions', (SELECT count(*) FROM public.transactions WHERE status = 'completed'),
    'total_volume_kobo', (SELECT COALESCE(sum(amount_ngn),0) FROM public.transactions WHERE status = 'completed'),
    'recent', (
      SELECT COALESCE(jsonb_agg(jsonb_build_object('type', r.type, 'amount_kobo', r.amount_ngn, 'occurred_at', r.created_at) ORDER BY r.created_at DESC), '[]'::jsonb)
      FROM (
        SELECT type, amount_ngn, created_at FROM public.transactions
        WHERE status = 'completed'
        ORDER BY created_at DESC
        LIMIT LEAST(GREATEST(p_recent_limit, 1), 20)
      ) r
    )
  )
$$;
REVOKE EXECUTE ON FUNCTION public.admin_share_report(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_share_report(INT) TO service_role;
