-- Durable funding evidence, provider-scoped idempotency, and reconciliation
-- checkpoints for Paystack and Flutterwave virtual-account deposits.

CREATE TABLE public.funding_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL CHECK (provider IN ('paystack','flutterwave')),
  provider_reference TEXT NOT NULL CHECK (length(provider_reference) BETWEEN 1 AND 200),
  provider_transaction_id TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  amount_kobo BIGINT NOT NULL CHECK (amount_kobo > 0),
  currency TEXT NOT NULL CHECK (currency = 'NGN'),
  receiving_account TEXT,
  provider_customer_code TEXT,
  provider_virtual_account_id TEXT,
  event_source TEXT NOT NULL CHECK (event_source IN ('webhook','reconcile')),
  status TEXT NOT NULL CHECK (status IN ('received','credited','duplicate','unmatched','rejected','error')),
  error_code TEXT,
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts > 0),
  provider_created_at TIMESTAMPTZ,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(provider, provider_reference)
);
CREATE INDEX funding_events_unresolved_idx
  ON public.funding_events(status, last_seen_at)
  WHERE status IN ('received','unmatched','error');
CREATE INDEX funding_events_user_created_idx ON public.funding_events(user_id, created_at DESC);

CREATE TABLE public.funding_reconciliation_state (
  provider TEXT PRIMARY KEY CHECK (provider IN ('paystack','flutterwave')),
  window_from TIMESTAMPTZ,
  window_to TIMESTAMPTZ,
  next_page INTEGER NOT NULL DEFAULT 1 CHECK (next_page > 0),
  last_success_at TIMESTAMPTZ,
  last_run_at TIMESTAMPTZ,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.funding_reconciliation_state(provider,last_run_at) VALUES ('paystack',now()),('flutterwave',now())
ON CONFLICT(provider) DO NOTHING;

ALTER TABLE public.funding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.funding_reconciliation_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.funding_events, public.funding_reconciliation_state FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.funding_events, public.funding_reconciliation_state TO service_role;

-- Replace the existing RPC without changing its public signature. New rows use
-- provider:reference, while a matching legacy unscoped row still blocks replay.
CREATE OR REPLACE FUNCTION public.credit_wallet_funding(
  p_user_id UUID,
  p_reference TEXT,
  p_amount BIGINT,
  p_source TEXT DEFAULT 'paystack'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_balance BIGINT;
  v_inserted INTEGER := 0;
  v_scoped_reference TEXT;
  v_legacy_match BOOLEAN := FALSE;
BEGIN
  IF p_source NOT IN ('paystack','flutterwave') THEN RAISE EXCEPTION 'INVALID_FUNDING_SOURCE'; END IF;
  IF p_reference IS NULL OR length(trim(p_reference)) NOT BETWEEN 1 AND 200 THEN RAISE EXCEPTION 'INVALID_REFERENCE'; END IF;
  IF p_amount IS NULL OR p_amount <= 0 THEN RAISE EXCEPTION 'INVALID_AMOUNT'; END IF;
  v_scoped_reference := p_source || ':' || trim(p_reference);

  SELECT EXISTS (
    SELECT 1 FROM public.processed_payments pp
    WHERE pp.reference = trim(p_reference)
      AND pp.user_id = p_user_id
      AND pp.amount_ngn = p_amount
      AND EXISTS (
        SELECT 1 FROM public.transactions t
        WHERE t.user_id = p_user_id AND t.type = 'wallet_fund'
          AND t.amount_ngn = p_amount
          AND t.metadata->>'source' = p_source
          AND t.metadata->>'reference' = trim(p_reference)
      )
  ) INTO v_legacy_match;

  IF v_legacy_match OR EXISTS (
    SELECT 1 FROM public.processed_payments WHERE reference = v_scoped_reference
  ) THEN
    SELECT balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('credited', false, 'balance', COALESCE(v_balance, 0), 'amount', p_amount);
  END IF;

  INSERT INTO public.processed_payments(reference, user_id, amount_ngn)
  VALUES(v_scoped_reference, p_user_id, p_amount)
  ON CONFLICT(reference) DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 0 THEN
    SELECT balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id;
    RETURN jsonb_build_object('credited', false, 'balance', COALESCE(v_balance, 0), 'amount', p_amount);
  END IF;

  INSERT INTO public.users(id) VALUES(p_user_id) ON CONFLICT(id) DO NOTHING;
  INSERT INTO public.wallets(user_id) VALUES(p_user_id) ON CONFLICT(user_id) DO NOTHING;
  SELECT balance INTO v_balance FROM public.wallets WHERE user_id = p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'WALLET_NOT_FOUND'; END IF;
  UPDATE public.wallets SET balance = balance + p_amount, updated_at = now() WHERE user_id = p_user_id;
  INSERT INTO public.transactions(user_id,type,amount_ngn,status,metadata,completed_at)
  VALUES(p_user_id,'wallet_fund',p_amount,'completed',
    jsonb_build_object('source',p_source,'reference',trim(p_reference),'idempotency_reference',v_scoped_reference),now());
  RETURN jsonb_build_object('credited',true,'balance',v_balance+p_amount,'amount',p_amount);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.credit_wallet_funding(UUID,TEXT,BIGINT,TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.credit_wallet_funding(UUID,TEXT,BIGINT,TEXT) TO service_role;
