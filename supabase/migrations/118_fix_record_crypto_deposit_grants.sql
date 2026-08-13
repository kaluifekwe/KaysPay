-- Fixes a real gap flagged by the automated privilege monitor: migration
-- 117's record_crypto_deposit only revoked EXECUTE from PUBLIC, not the
-- explicit anon/authenticated roles Supabase grants by default on function
-- creation — every other privileged function this session correctly
-- revoked from all three. Confirmed via has_function_privilege() that both
-- anon and authenticated could call this directly with no auth, letting
-- anyone insert a fabricated "completed" crypto_deposit transaction into
-- any user's history (no balance/wallet is touched by this function, so no
-- funds were ever at risk — but it's still an unauthenticated write to
-- another user's data and must be locked down like every other RPC here).
REVOKE EXECUTE ON FUNCTION public.record_crypto_deposit(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_crypto_deposit(UUID, TEXT, BIGINT, TEXT, TEXT, TEXT) TO service_role;
