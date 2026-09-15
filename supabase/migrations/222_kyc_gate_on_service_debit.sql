-- Closes a real gap found 2026-09-12: KYC was only ever enforced on money
-- COMING IN (funding-credit.ts, migration 7a5d1be, 2026-08-31), never on
-- money going OUT. An unverified user could always spend whatever was
-- already sitting in their wallet -- including balances funded before that
-- gate existed -- because no purchase path checked KYC status at all.
-- debit_for_service is the single shared server-side money-out boundary for
-- every paid service (airtime/data/bills/TV/exam pins via vtu-purchase,
-- esim-purchase, foreign-number-purchase, nin-verify, nin-validate,
-- nin-modify, bvn-verify), so enforcing it here covers all of them at once
-- and can't be bypassed by an old app build or a modified client, same
-- reasoning as the funding-side gate's own comment.
CREATE OR REPLACE FUNCTION public.debit_for_service(
  p_user_id uuid,
  p_amount bigint,
  p_type text,
  p_network text,
  p_recipient text,
  p_metadata jsonb,
  p_idempotency_key text,
  p_use_cashback boolean DEFAULT false
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance BIGINT; v_cashback_balance BIGINT; v_cashback_used BIGINT; v_wallet_used BIGINT;
  v_tx_id UUID; v_provider_cost BIGINT; v_cost_source TEXT; v_kyc_status TEXT;
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

  SELECT status INTO v_kyc_status FROM user_kyc WHERE user_id=p_user_id;
  IF v_kyc_status IS DISTINCT FROM 'verified' THEN RAISE EXCEPTION 'KYC_NOT_VERIFIED';END IF;

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
END;$function$;
