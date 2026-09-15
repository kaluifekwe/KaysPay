-- Read-only helper for the existing-customer 9PSB backfill (admin-refund's
-- target: "9psb_backfill_provisioning"): KYC-verified users who don't yet
-- have any virtual_accounts row for provider '9psb' (active OR
-- pending_identity -- a user already mid-setup should not be re-queued).
-- Batched via p_limit since this is called repeatedly, not all at once.

CREATE OR REPLACE FUNCTION public.admin_list_kyc_verified_without_9psb_wallet(p_limit INT DEFAULT 20)
RETURNS TABLE(user_id UUID, nin TEXT, bvn TEXT, phone TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT uk.user_id, uk.nin, uk.bvn, au.phone
  FROM public.user_kyc uk
  JOIN auth.users au ON au.id = uk.user_id
  WHERE uk.status = 'verified'
    AND NOT EXISTS (
      SELECT 1 FROM public.virtual_accounts va
      WHERE va.user_id = uk.user_id AND va.provider = '9psb'
    )
  ORDER BY uk.user_id
  LIMIT greatest(1, least(p_limit, 100));
$$;

REVOKE ALL ON FUNCTION public.admin_list_kyc_verified_without_9psb_wallet(INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_list_kyc_verified_without_9psb_wallet(INT) TO service_role;
