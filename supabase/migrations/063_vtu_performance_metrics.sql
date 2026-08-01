-- Privacy-safe, sampled airtime/data latency measurements.
-- No user id, recipient, amount, balance, token, PIN or provider payload is stored.

CREATE TABLE IF NOT EXISTS public.vtu_performance_metrics (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id UUID NOT NULL REFERENCES public.transactions(id) ON DELETE CASCADE,
  service TEXT NOT NULL CHECK (service IN ('airtime', 'data')),
  network TEXT NOT NULL CHECK (network IN ('mtn', 'airtel', 'glo', '9mobile')),
  provider TEXT NOT NULL CHECK (provider IN ('vtu_ng', 'vtuafrica')),
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'pending', 'failed', 'error')),
  pre_debit_ms INTEGER NOT NULL CHECK (pre_debit_ms >= 0),
  debit_ms INTEGER NOT NULL CHECK (debit_ms >= 0),
  provider_ms INTEGER NOT NULL CHECK (provider_ms >= 0),
  settlement_ms INTEGER NOT NULL CHECK (settlement_ms >= 0),
  total_ms INTEGER NOT NULL CHECK (total_ms >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (transaction_id)
);

CREATE INDEX IF NOT EXISTS idx_vtu_performance_service_network_created
  ON public.vtu_performance_metrics(service, network, created_at DESC);

ALTER TABLE public.vtu_performance_metrics ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_performance_metrics FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.vtu_performance_metrics TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.vtu_performance_metrics_id_seq TO service_role;

-- Internal report for Supabase SQL Editor/service-role use. Percentiles reveal
-- whether delay is in Kay's Pay or at the provider, split by service/network.
CREATE OR REPLACE FUNCTION public.vtu_performance_report(p_since INTERVAL DEFAULT INTERVAL '24 hours')
RETURNS TABLE (
  service TEXT,
  network TEXT,
  outcome TEXT,
  samples BIGINT,
  total_p50_ms INTEGER,
  total_p95_ms INTEGER,
  provider_p50_ms INTEGER,
  provider_p95_ms INTEGER,
  debit_p95_ms INTEGER
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    m.service,
    m.network,
    m.outcome,
    count(*) AS samples,
    percentile_disc(0.50) WITHIN GROUP (ORDER BY m.total_ms)::INTEGER,
    percentile_disc(0.95) WITHIN GROUP (ORDER BY m.total_ms)::INTEGER,
    percentile_disc(0.50) WITHIN GROUP (ORDER BY m.provider_ms)::INTEGER,
    percentile_disc(0.95) WITHIN GROUP (ORDER BY m.provider_ms)::INTEGER,
    percentile_disc(0.95) WITHIN GROUP (ORDER BY m.debit_ms)::INTEGER
  FROM public.vtu_performance_metrics m
  WHERE m.created_at >= now() - p_since
  GROUP BY m.service, m.network, m.outcome
  ORDER BY m.service, m.network, m.outcome;
$$;

REVOKE ALL ON FUNCTION public.vtu_performance_report(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.vtu_performance_report(INTERVAL) TO service_role;
