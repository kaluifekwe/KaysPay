-- Security audit fixes (2026-08-06). Two critical findings, both the same
-- root cause: `REVOKE EXECUTE ... FROM PUBLIC` alone does NOT cover the
-- `anon`/`authenticated` roles on this project — Supabase auto-grants
-- EXECUTE to them on every new function by default, independent of the
-- PUBLIC pseudo-role. Every correctly-locked-down function elsewhere in
-- this codebase (see migration 057's bulk sweep) explicitly revokes
-- `FROM PUBLIC, anon, authenticated`; these six did not, and were
-- confirmed anon-callable via Supabase's own security advisor.
--
-- 1) buy_crypto / sell_crypto / debit_crypto_for_withdrawal /
--    refund_crypto_withdrawal (migration 082, this session): all take a
--    raw p_user_id with no internal auth.uid() check, so an anonymous
--    caller could move ANY user's wallet/crypto balance directly via
--    PostgREST, bypassing the edge functions' auth, PIN step-up, and rate
--    limiting entirely.
-- 2) set_pending_profile_change / consume_pending_profile_change
--    (migration 077, pre-existing): same gap — an anonymous caller could
--    overwrite a victim's pending email/phone change before they enter
--    their OTP, so the victim's own valid OTP could end up applying the
--    attacker's chosen value.
REVOKE EXECUTE ON FUNCTION public.buy_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.sell_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.debit_crypto_for_withdrawal(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.refund_crypto_withdrawal(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.set_pending_profile_change(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.consume_pending_profile_change(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- Re-grant service_role explicitly (REVOKE above doesn't touch it, but
-- making it explicit here documents intent and survives a future blanket
-- REVOKE ALL by accident).
GRANT EXECUTE ON FUNCTION public.buy_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.sell_crypto(UUID, TEXT, BIGINT, BIGINT, NUMERIC, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.debit_crypto_for_withdrawal(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.refund_crypto_withdrawal(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.set_pending_profile_change(UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.consume_pending_profile_change(UUID, TEXT) TO service_role;

-- Medium finding: create_user_wallet() (migration 001) is SECURITY DEFINER
-- without a pinned search_path — the one function in the project that
-- didn't follow the SET search_path = public convention used everywhere
-- else. Low practical exploitability (it's a trigger, not client-callable),
-- but closing it for consistency/defense-in-depth, same fix shape as every
-- other function here.
CREATE OR REPLACE FUNCTION public.create_user_wallet()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO wallets (user_id, balance)
  VALUES (NEW.id, 0.00);
  RETURN NEW;
END;
$$;
