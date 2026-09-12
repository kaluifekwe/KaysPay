-- Closes the remaining instances of the idempotency-replay bug (Strix
-- finding #4) across the live crypto money-movement functions. Strix's own
-- suggested locations (buy_crypto, sell_crypto, debit_crypto_for_withdrawal)
-- turned out to be dead code -- no live edge function calls any of them
-- anymore (confirmed via a repo-wide grep). The actual live functions have
-- different names and the exact same unscoped-lookup pattern:
--
--   record_crypto_sell_offramp_pending / record_crypto_sell_swap_pending
--     (crypto-sell/index.ts) -- keyed on a client-supplied
--     body.idempotency_key (falls back to a server default only if omitted)
--   record_crypto_withdrawal_pending (crypto-withdraw/index.ts) -- keyed on
--     the same client-suppliable body.idempotency_key, passed through as
--     p_reference
--   start_crypto_buy (crypto-buy/index.ts) -- keyed on the same
--     client-suppliable body.idempotency_key, passed through as
--     p_merchant_reference
--
-- All four confirmed client-exploitable: an attacker can supply another
-- user's key and get back that user's pending transaction id instead of
-- starting their own -- at minimum a record-confusion bug (a later webhook
-- resolving "their" transaction id would actually mutate the victim's real
-- pending crypto operation), same root cause class as the debit_for_transfer
-- fix in migration 223.
CREATE OR REPLACE FUNCTION public.record_crypto_sell_offramp_pending(
  p_user_id uuid, p_asset text, p_crypto_micro bigint, p_reference text,
  p_merchant_reference text, p_recipient_bank_name text,
  p_recipient_account_number text, p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tx_id UUID; v_existing_user UUID; v_existing_micro BIGINT; v_existing_account TEXT;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 OR p_reference IS NULL OR p_merchant_reference IS NULL THEN
    RAISE EXCEPTION 'INVALID_SELL';
  END IF;

  SELECT id, user_id, (metadata->>'crypto_micro')::BIGINT, metadata->>'recipient_account_number'
    INTO v_tx_id, v_existing_user, v_existing_micro, v_existing_account
    FROM transactions WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    IF v_existing_user = p_user_id AND v_existing_micro = p_crypto_micro
       AND v_existing_account IS NOT DISTINCT FROM p_recipient_account_number THEN
      RETURN v_tx_id;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_sell', p_asset, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'quidax_reference', p_reference,
                              'quidax_merchant_reference', p_merchant_reference,
                              'recipient_bank_name', p_recipient_bank_name,
                              'recipient_account_number', p_recipient_account_number,
                              'settlement', 'offramp_direct',
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_crypto_sell_swap_pending(
  p_user_id uuid, p_source_asset text, p_source_crypto_micro bigint, p_swap_quotation_id text,
  p_recipient_bank_name text, p_recipient_account_number text, p_bank_code text, p_idempotency_key text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tx_id UUID; v_existing_user UUID; v_existing_micro BIGINT; v_existing_account TEXT;
BEGIN
  IF p_source_crypto_micro IS NULL OR p_source_crypto_micro <= 0 OR p_swap_quotation_id IS NULL THEN
    RAISE EXCEPTION 'INVALID_SELL';
  END IF;

  SELECT id, user_id, (metadata->>'crypto_micro')::BIGINT, metadata->>'recipient_account_number'
    INTO v_tx_id, v_existing_user, v_existing_micro, v_existing_account
    FROM transactions WHERE metadata->>'idempotency_key' = p_idempotency_key LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    IF v_existing_user = p_user_id AND v_existing_micro = p_source_crypto_micro
       AND v_existing_account IS NOT DISTINCT FROM p_recipient_account_number THEN
      RETURN v_tx_id;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_sell', p_source_asset, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_source_asset, 'crypto_micro', p_source_crypto_micro,
                              'swap_quotation_id', p_swap_quotation_id,
                              'recipient_bank_name', p_recipient_bank_name,
                              'recipient_account_number', p_recipient_account_number,
                              'bank_code', p_bank_code,
                              'settlement', 'sell_via_swap',
                              'phase', 'awaiting_swap',
                              'idempotency_key', p_idempotency_key))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.record_crypto_withdrawal_pending(
  p_user_id uuid, p_asset text, p_crypto_micro bigint, p_network text, p_address text, p_reference text
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tx_id UUID; v_existing_user UUID; v_existing_micro BIGINT; v_existing_address TEXT;
BEGIN
  IF p_crypto_micro IS NULL OR p_crypto_micro <= 0 OR p_reference IS NULL THEN
    RAISE EXCEPTION 'INVALID_WITHDRAWAL';
  END IF;

  SELECT id, user_id, (metadata->>'crypto_micro')::BIGINT, metadata->>'address'
    INTO v_tx_id, v_existing_user, v_existing_micro, v_existing_address
    FROM transactions WHERE metadata->>'quidax_reference' = p_reference LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    IF v_existing_user = p_user_id AND v_existing_micro = p_crypto_micro
       AND v_existing_address IS NOT DISTINCT FROM p_address THEN
      RETURN v_tx_id;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_withdraw', p_address, 'N/A', 0, 'pending',
          jsonb_build_object('asset', p_asset, 'crypto_micro', p_crypto_micro,
                              'crypto_network', p_network, 'address', p_address,
                              'quidax_reference', p_reference,
                              'idempotency_key', p_reference))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.start_crypto_buy(
  p_user_id uuid, p_merchant_reference text, p_ngn_kobo bigint, p_estimated_micro bigint,
  p_rate numeric, p_asset text, p_metadata jsonb DEFAULT '{}'::jsonb
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
DECLARE
  v_tx_id UUID; v_existing_user UUID; v_existing_amount BIGINT; v_existing_asset TEXT;
BEGIN
  IF p_merchant_reference IS NULL OR length(p_merchant_reference) = 0
     OR p_ngn_kobo IS NULL OR p_ngn_kobo <= 0
     OR p_asset IS NULL OR length(p_asset) = 0 THEN
    RAISE EXCEPTION 'INVALID_BUY_ORDER';
  END IF;

  SELECT id, user_id, amount_ngn, metadata->>'asset'
    INTO v_tx_id, v_existing_user, v_existing_amount, v_existing_asset
    FROM transactions WHERE metadata->>'quidax_merchant_reference' = p_merchant_reference LIMIT 1;
  IF v_tx_id IS NOT NULL THEN
    IF v_existing_user = p_user_id AND v_existing_amount = p_ngn_kobo
       AND v_existing_asset IS NOT DISTINCT FROM p_asset THEN
      RETURN v_tx_id;
    ELSE
      RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSE';
    END IF;
  END IF;

  INSERT INTO transactions (user_id, type, recipient_phone, network, amount_ngn, status, metadata)
  VALUES (p_user_id, 'crypto_buy', p_asset, 'N/A', p_ngn_kobo, 'pending',
          COALESCE(p_metadata, '{}'::jsonb) || jsonb_build_object(
            'asset', p_asset,
            'quidax_merchant_reference', p_merchant_reference,
            'estimated_crypto_micro', p_estimated_micro,
            'rate', p_rate,
            'funding', 'bank_transfer'
          ))
  RETURNING id INTO v_tx_id;

  RETURN v_tx_id;
END;
$function$;
