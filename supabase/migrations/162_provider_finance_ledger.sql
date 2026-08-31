CREATE TABLE public.provider_finance_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK(provider ~ '^[a-z0-9_-]{2,40}$'),
  entry_type TEXT NOT NULL CHECK(entry_type IN ('wallet_funding','funding_fee','operating_expense','balance_snapshot','adjustment')),
  amount_kobo BIGINT NOT NULL CHECK(
    (entry_type='adjustment' AND amount_kobo<>0) OR
    (entry_type<>'adjustment' AND amount_kobo>0)
  ),
  expense_category TEXT CHECK(expense_category IS NULL OR expense_category ~ '^[a-z0-9_-]{2,40}$'),
  reference TEXT CHECK(reference IS NULL OR char_length(reference)<=120),
  notes TEXT CHECK(notes IS NULL OR char_length(notes)<=500),
  occurred_at TIMESTAMPTZ NOT NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_finance_entries_period_idx ON public.provider_finance_entries(occurred_at DESC);
CREATE INDEX provider_finance_entries_provider_idx ON public.provider_finance_entries(provider,occurred_at DESC);
ALTER TABLE public.provider_finance_entries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.provider_finance_entries FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.provider_finance_entries TO service_role;

CREATE OR REPLACE FUNCTION public.admin_provider_finance_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH period_entries AS (
  SELECT * FROM provider_finance_entries WHERE occurred_at>=p_start AND occurred_at<p_end
), completed AS (
  SELECT lower(COALESCE(NULLIF(metadata->>'provider',''),cost_source,'unknown')) provider,
    provider_cost_kobo,net_profit_after_cashback_kobo
  FROM transactions
  WHERE status='completed' AND created_at>=p_start AND created_at<p_end AND provider_cost_kobo IS NOT NULL
), lifetime_completed AS (
  SELECT lower(COALESCE(NULLIF(metadata->>'provider',''),cost_source,'unknown')) provider,
    COALESCE(sum(provider_cost_kobo),0) provider_spend_kobo
  FROM transactions WHERE status='completed' AND created_at<p_end AND provider_cost_kobo IS NOT NULL GROUP BY 1
), latest_balances AS (
  SELECT DISTINCT ON(provider) provider,amount_kobo balance_kobo,occurred_at
  FROM provider_finance_entries WHERE entry_type='balance_snapshot' AND occurred_at<p_end
  ORDER BY provider,occurred_at DESC,created_at DESC
), providers AS (
  SELECT provider FROM provider_finance_entries WHERE occurred_at<p_end
  UNION SELECT provider FROM completed
), provider_rows AS (
  SELECT p.provider,
    COALESCE((SELECT sum(amount_kobo) FROM period_entries e WHERE e.provider=p.provider AND e.entry_type='wallet_funding'),0) funded_kobo,
    COALESCE((SELECT sum(amount_kobo) FROM period_entries e WHERE e.provider=p.provider AND e.entry_type='funding_fee'),0) funding_fees_kobo,
    COALESCE((SELECT sum(provider_cost_kobo) FROM completed c WHERE c.provider=p.provider),0) provider_spend_kobo,
    COALESCE((SELECT sum(net_profit_after_cashback_kobo) FROM completed c WHERE c.provider=p.provider),0) covered_net_profit_kobo,
    b.balance_kobo,b.occurred_at balance_recorded_at,
    COALESCE((SELECT sum(amount_kobo) FROM provider_finance_entries e WHERE e.provider=p.provider AND e.entry_type='wallet_funding' AND e.occurred_at<p_end),0)
      +COALESCE((SELECT sum(amount_kobo) FROM provider_finance_entries e WHERE e.provider=p.provider AND e.entry_type='adjustment' AND e.occurred_at<p_end),0)
      -COALESCE(l.provider_spend_kobo,0)-COALESCE(b.balance_kobo,0) unreconciled_kobo
  FROM providers p LEFT JOIN latest_balances b USING(provider) LEFT JOIN lifetime_completed l USING(provider)
), totals AS (
 SELECT COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='wallet_funding'),0) funded_kobo,
  COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='funding_fee'),0) funding_fees_kobo,
  COALESCE(sum(amount_kobo) FILTER(WHERE entry_type='operating_expense'),0) operating_expenses_kobo
 FROM period_entries
)
SELECT jsonb_build_object(
 'funded_kobo',t.funded_kobo,'funding_fees_kobo',t.funding_fees_kobo,'operating_expenses_kobo',t.operating_expenses_kobo,
 'covered_net_profit_before_expenses_kobo',COALESCE((SELECT sum(net_profit_after_cashback_kobo) FROM completed),0),
 'covered_net_profit_after_expenses_kobo',COALESCE((SELECT sum(net_profit_after_cashback_kobo) FROM completed),0)-t.funding_fees_kobo-t.operating_expenses_kobo,
 'providers',COALESCE((SELECT jsonb_agg(to_jsonb(provider_rows) ORDER BY provider) FROM provider_rows),'[]'::jsonb),
 'expense_categories',COALESCE((SELECT jsonb_agg(to_jsonb(x) ORDER BY x.amount_kobo DESC) FROM
   (SELECT COALESCE(expense_category,'other') category,sum(amount_kobo) amount_kobo FROM period_entries WHERE entry_type='operating_expense' GROUP BY 1)x),'[]'::jsonb)
) FROM totals t;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_provider_finance_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_provider_finance_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;

