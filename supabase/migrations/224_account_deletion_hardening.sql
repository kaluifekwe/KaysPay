-- Closes three real gaps in admin_delete_customer_account found by a Strix
-- pentest scan 2026-09-12 (findings #3, #6, #7):
--
-- 1. No target-class guard: a super_admin could delete/permanently-ban any
--    OTHER admin's account (or their own), since the function only checked
--    that the target row exists in `users`, never whether it belongs to an
--    administrator. Checking admin_users also inherently blocks
--    self-deletion, since every admin has a row there.
--
-- 2. The "block deletion while a transaction is in flight" check read
--    wallets.locked_amount, a column NOTHING in the codebase ever writes --
--    confirmed via a repo-wide search. The guard could never fire. Replaced
--    with a real check against actually-pending transactions/withdrawals.
--
-- 3. The published policy (kayspay-web/public/delete-account/index.html)
--    promises NIN/BVN identity data, email, and device data are deleted.
--    This function only cleared the user_kyc STATUS row -- the full NIN
--    verification record (name, DOB, photo) that nin-verify/nin-modify
--    persist into transactions.metadata was left untouched (transactions
--    themselves are deliberately kept for regulatory retention, but the PII
--    subset of their metadata was never scrubbed), and
--    email_verification_codes/pending_profile_changes/device_sessions rows
--    were never removed either.
CREATE OR REPLACE FUNCTION public.admin_delete_customer_account(
  p_admin_user_id uuid,
  p_user_id uuid,
  p_reason text,
  p_confirm_balance_handled boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_balance               BIGINT;
  v_locked_amount         BIGINT;
  v_cashback_balance_kobo BIGINT;
  v_balance_tx_id         UUID;
  v_deleted_at            TIMESTAMPTZ;
  v_pins_deleted          INT;
  v_kyc_deleted           INT;
  v_billing_deleted       INT;
  v_push_deleted          INT;
  v_va_deleted            INT;
BEGIN
  IF p_reason IS NULL OR trim(p_reason) = '' THEN
    RAISE EXCEPTION 'REASON_REQUIRED';
  END IF;

  PERFORM 1 FROM users WHERE id = p_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'USER_NOT_FOUND';
  END IF;

  -- Administrator accounts (this also covers self-deletion, since every
  -- admin has a row here) must be offboarded from admin_users first, never
  -- deleted through the customer-deletion path.
  IF EXISTS (SELECT 1 FROM admin_users WHERE user_id = p_user_id) THEN
    RAISE EXCEPTION 'ADMIN_ACCOUNT_NOT_DELETABLE';
  END IF;

  SELECT deleted_at INTO v_deleted_at FROM customer_subjects WHERE subject_id = p_user_id;
  IF v_deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ALREADY_DELETED';
  END IF;

  -- Real in-flight check: any transaction still actively being processed,
  -- or a bank withdrawal still in progress. wallets.locked_amount is never
  -- written anywhere in this codebase, so it can never signal this.
  IF EXISTS (SELECT 1 FROM transactions WHERE user_id = p_user_id AND status = 'pending')
     OR EXISTS (SELECT 1 FROM withdrawals WHERE user_id = p_user_id AND status IN ('pending', 'processing')) THEN
    RAISE EXCEPTION 'WALLET_LOCKED_FUNDS';
  END IF;

  SELECT balance, locked_amount, cashback_balance_kobo
    INTO v_balance, v_locked_amount, v_cashback_balance_kobo
    FROM wallets WHERE user_id = p_user_id FOR UPDATE;

  IF FOUND THEN
    IF COALESCE(v_balance, 0) <> 0 OR COALESCE(v_cashback_balance_kobo, 0) <> 0 THEN
      IF NOT p_confirm_balance_handled THEN
        RAISE EXCEPTION 'WALLET_BALANCE_NOT_ZERO';
      END IF;

      IF COALESCE(v_balance, 0) > 0 THEN
        INSERT INTO transactions (user_id, type, amount_ngn, status, metadata, completed_at)
        VALUES (
          p_user_id, 'wallet_correction', v_balance, 'completed',
          jsonb_build_object(
            'direction', 'debit',
            'reason', 'Account deletion: remaining wallet balance cleared',
            'admin_user_id', p_admin_user_id
          ),
          now()
        )
        RETURNING id INTO v_balance_tx_id;
      END IF;

      UPDATE wallets SET balance = 0, cashback_balance_kobo = 0, updated_at = now()
      WHERE user_id = p_user_id;
    END IF;
  END IF;

  WITH deleted AS (DELETE FROM user_pins WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_pins_deleted FROM deleted;
  WITH deleted AS (DELETE FROM user_kyc WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_kyc_deleted FROM deleted;
  WITH deleted AS (DELETE FROM saved_billing_accounts WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_billing_deleted FROM deleted;
  WITH deleted AS (DELETE FROM push_tokens WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_push_deleted FROM deleted;
  WITH deleted AS (DELETE FROM virtual_accounts WHERE user_id = p_user_id RETURNING 1)
    SELECT count(*) INTO v_va_deleted FROM deleted;

  DELETE FROM email_verification_codes WHERE user_id = p_user_id;
  DELETE FROM pending_profile_changes WHERE user_id = p_user_id;
  DELETE FROM device_sessions WHERE user_id = p_user_id;

  -- transactions themselves are kept (regulatory retention), but the raw
  -- NIN/BVN identity payload -- including the verification photo -- and the
  -- NIN itself (stored in recipient_phone by convention) are scrubbed from
  -- every identity-related transaction type.
  UPDATE transactions
  SET recipient_phone = NULL,
      metadata = metadata - 'record' - 'nin' - 'date_of_birth' - 'dob'
                          - 'new_surname' - 'new_firstname' - 'new_phone_number'
                          - 'new_address' - 'phone_number' - 'middlename' - 'claimed'
  WHERE user_id = p_user_id
    AND type IN (
      'nin_verification', 'nin_validation', 'bvn_verification',
      'nin_name_modification', 'nin_phone_modification', 'nin_address_modification'
    );

  UPDATE users
  SET phone = NULL, full_name = NULL, avatar_url = NULL,
      pin_hash = NULL, biometric_enabled = false
  WHERE id = p_user_id;

  UPDATE customer_subjects SET deleted_at = now(), updated_at = now()
  WHERE subject_id = p_user_id;
  IF NOT FOUND THEN
    INSERT INTO customer_subjects (subject_id, joined_at, deleted_at)
    VALUES (p_user_id, now(), now());
  END IF;

  RETURN jsonb_build_object(
    'balance_cleared_kobo', COALESCE(v_balance, 0),
    'balance_clear_transaction_id', v_balance_tx_id,
    'pins_deleted', v_pins_deleted,
    'kyc_deleted', v_kyc_deleted,
    'billing_accounts_deleted', v_billing_deleted,
    'push_tokens_deleted', v_push_deleted,
    'virtual_accounts_deleted', v_va_deleted
  );
END;
$function$;
