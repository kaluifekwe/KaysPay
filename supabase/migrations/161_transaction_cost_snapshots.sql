ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS customer_price_kobo BIGINT CHECK(customer_price_kobo IS NULL OR customer_price_kobo>0),
  ADD COLUMN IF NOT EXISTS provider_cost_kobo BIGINT CHECK(provider_cost_kobo IS NULL OR provider_cost_kobo>=0),
  ADD COLUMN IF NOT EXISTS cost_source TEXT CHECK(cost_source IS NULL OR cost_source ~ '^[a-z0-9_-]{2,40}$'),
  ADD COLUMN IF NOT EXISTS cost_captured_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS gross_profit_kobo BIGINT GENERATED ALWAYS AS
    (CASE WHEN customer_price_kobo IS NOT NULL AND provider_cost_kobo IS NOT NULL THEN customer_price_kobo-provider_cost_kobo END) STORED,
  ADD COLUMN IF NOT EXISTS net_profit_after_cashback_kobo BIGINT GENERATED ALWAYS AS
    (CASE WHEN customer_price_kobo IS NOT NULL AND provider_cost_kobo IS NOT NULL THEN customer_price_kobo-provider_cost_kobo-cashback_used_kobo END) STORED;

CREATE OR REPLACE FUNCTION public.debit_for_service(
  p_user_id UUID,p_amount BIGINT,p_type TEXT,p_network TEXT,p_recipient TEXT,
  p_metadata JSONB,p_idempotency_key TEXT,p_use_cashback BOOLEAN DEFAULT FALSE
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_balance BIGINT;v_cashback_balance BIGINT;v_cashback_used BIGINT;v_wallet_used BIGINT;v_tx_id UUID;v_provider_cost BIGINT;v_cost_source TEXT;
BEGIN
  IF p_amount IS NULL OR p_amount<=0 THEN RAISE EXCEPTION 'INVALID_AMOUNT';END IF;
  SELECT id INTO v_tx_id FROM transactions WHERE metadata->>'idempotency_key'=p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN RETURN v_tx_id;END IF;
  IF p_metadata ? 'provider_cost_kobo' THEN
    IF p_metadata->>'provider_cost_kobo' !~ '^\d{1,12}$' THEN RAISE EXCEPTION 'INVALID_PROVIDER_COST';END IF;
    v_provider_cost=(p_metadata->>'provider_cost_kobo')::BIGINT;
    v_cost_source=COALESCE(NULLIF(regexp_replace(lower(p_metadata->>'cost_source'),'[^a-z0-9_-]','','g'),''),'provider_catalog');
    IF v_provider_cost<0 OR length(v_cost_source)>40 THEN RAISE EXCEPTION 'INVALID_PROVIDER_COST';END IF;
  END IF;
  SELECT balance,cashback_balance_kobo INTO v_balance,v_cashback_balance FROM wallets WHERE user_id=p_user_id FOR UPDATE;
  IF v_balance IS NULL THEN RAISE EXCEPTION 'WALLET_NOT_FOUND';END IF;
  v_cashback_used=CASE WHEN p_use_cashback THEN LEAST(COALESCE(v_cashback_balance,0),p_amount) ELSE 0 END;v_wallet_used=p_amount-v_cashback_used;
  IF v_balance<v_wallet_used THEN RAISE EXCEPTION 'INSUFFICIENT_FUNDS';END IF;
  UPDATE wallets SET balance=balance-v_wallet_used,cashback_balance_kobo=cashback_balance_kobo-v_cashback_used,updated_at=now() WHERE user_id=p_user_id;
  INSERT INTO transactions(user_id,type,recipient_phone,network,amount_ngn,status,metadata,cashback_used_kobo,customer_price_kobo,provider_cost_kobo,cost_source,cost_captured_at)
  VALUES(p_user_id,p_type,p_recipient,COALESCE(p_network,'N/A'),p_amount,'pending',COALESCE(p_metadata,'{}')||jsonb_build_object('idempotency_key',p_idempotency_key),v_cashback_used,p_amount,v_provider_cost,v_cost_source,CASE WHEN v_provider_cost IS NOT NULL THEN now() END)
  RETURNING id INTO v_tx_id;
  IF v_cashback_used>0 THEN INSERT INTO cashback_ledger(transaction_id,user_id,entry_type,amount_kobo,balance_after_kobo) VALUES(v_tx_id,p_user_id,'redeemed',v_cashback_used,v_cashback_balance-v_cashback_used) ON CONFLICT(transaction_id,entry_type) DO NOTHING;END IF;
  RETURN v_tx_id;
END;$$;
REVOKE EXECUTE ON FUNCTION public.debit_for_service(UUID,BIGINT,TEXT,TEXT,TEXT,JSONB,TEXT,BOOLEAN) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.debit_for_service(UUID,BIGINT,TEXT,TEXT,TEXT,JSONB,TEXT,BOOLEAN) TO service_role;

CREATE OR REPLACE FUNCTION public.admin_profit_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH completed AS (SELECT * FROM transactions WHERE status='completed' AND created_at>=p_start AND created_at<p_end), by_service AS (
 SELECT type,count(*) orders,count(*) FILTER(WHERE provider_cost_kobo IS NOT NULL) costed_orders,
  COALESCE(sum(customer_price_kobo) FILTER(WHERE provider_cost_kobo IS NOT NULL),0) covered_sales_kobo,
  COALESCE(sum(provider_cost_kobo),0) provider_cost_kobo,
  COALESCE(sum(gross_profit_kobo),0) gross_profit_kobo,
  COALESCE(sum(net_profit_after_cashback_kobo),0) net_profit_kobo
 FROM completed GROUP BY type)
SELECT jsonb_build_object('costed_orders',count(*) FILTER(WHERE provider_cost_kobo IS NOT NULL),'completed_orders',count(*),
 'coverage_percent',COALESCE(round(100.0*count(*) FILTER(WHERE provider_cost_kobo IS NOT NULL)/nullif(count(*),0),2),0),
 'covered_sales_kobo',COALESCE(sum(customer_price_kobo) FILTER(WHERE provider_cost_kobo IS NOT NULL),0),
 'provider_cost_kobo',COALESCE(sum(provider_cost_kobo),0),'gross_profit_kobo',COALESCE(sum(gross_profit_kobo),0),
 'net_profit_kobo',COALESCE(sum(net_profit_after_cashback_kobo),0),
 'gross_margin_percent',COALESCE(round(100.0*sum(gross_profit_kobo)/nullif(sum(customer_price_kobo) FILTER(WHERE provider_cost_kobo IS NOT NULL),0),2),0),
 'services',(SELECT COALESCE(jsonb_agg(to_jsonb(by_service) ORDER BY gross_profit_kobo DESC),'[]'::jsonb) FROM by_service)) FROM completed;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_profit_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_profit_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;
