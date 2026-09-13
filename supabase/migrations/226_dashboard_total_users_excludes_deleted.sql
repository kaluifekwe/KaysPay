-- total_users never dropped after a deletion because admin_delete_customer_account
-- can never actually remove the public.users row (transactions/wallets hold a
-- restrictive foreign key to it) -- it only anonymizes the row and marks
-- customer_subjects.deleted_at. The dashboard's total_users was a plain
-- count(*) with no awareness of that, so a deleted customer kept counting
-- toward the live headcount forever. new_users_in_range is left as-is: it's
-- a historical "how many joined in this past period" figure, which stays
-- true regardless of a later deletion.
CREATE OR REPLACE FUNCTION public.admin_dashboard_report(p_start timestamp with time zone, p_end timestamp with time zone)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT jsonb_build_object(
    'total_users', (
      SELECT count(*) FROM public.users u
      WHERE NOT EXISTS (
        SELECT 1 FROM public.customer_subjects cs
        WHERE cs.subject_id = u.id AND cs.deleted_at IS NOT NULL
      )
    ),
    'new_users_in_range', (SELECT count(*) FROM public.users WHERE created_at >= p_start AND created_at < p_end),
    'orders_in_range', (SELECT count(*) FROM public.transactions WHERE created_at >= p_start AND created_at < p_end),
    'orders_completed_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'completed' AND created_at >= p_start AND created_at < p_end),
    'orders_failed_in_range', (SELECT count(*) FROM public.transactions WHERE status = 'failed' AND COALESCE(metadata->>'refunded','') <> 'true' AND created_at >= p_start AND created_at < p_end),
    'orders_refunded_in_range', (SELECT count(*) FROM public.transactions WHERE (status = 'refunded' OR (status = 'failed' AND metadata->>'refunded' = 'true')) AND created_at >= p_start AND created_at < p_end),
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
$function$;
