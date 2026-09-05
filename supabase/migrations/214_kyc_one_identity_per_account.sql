-- Enforces one verified NIN/BVN per account. Confirmed live 2026-09-05:
-- kyc-verify-nin upserted user_kyc keyed only by user_id, with nothing
-- anywhere checking whether the SAME NIN or BVN had already been verified
-- on a DIFFERENT account. A live scan the same day found zero existing
-- duplicates (27 verified rows, 19 distinct NINs + 8 distinct BVNs, no
-- overlap), so this constraint can be added directly with no backfill
-- cleanup needed.
--
-- Stores a SHA-256 hash of the raw value for matching, not because the raw
-- nin/bvn columns are being touched here (they stay as-is, a separate,
-- larger remediation), but because the hash is what the UNIQUE index and
-- the duplicate check below actually key on -- same shape as
-- device_sessions.device_id_hash (migration 060).

ALTER TABLE public.user_kyc ADD COLUMN IF NOT EXISTS nin_hash TEXT;
ALTER TABLE public.user_kyc ADD COLUMN IF NOT EXISTS bvn_hash TEXT;

UPDATE public.user_kyc
   SET nin_hash = encode(extensions.digest(convert_to(nin, 'UTF8'), 'sha256'), 'hex')
 WHERE nin IS NOT NULL AND nin_hash IS NULL;

UPDATE public.user_kyc
   SET bvn_hash = encode(extensions.digest(convert_to(bvn, 'UTF8'), 'sha256'), 'hex')
 WHERE bvn IS NOT NULL AND bvn_hash IS NULL;

-- Partial: only VERIFIED rows are enforced -- an unverified/failed attempt
-- (or a re-verification in progress) must never block a different, unrelated
-- account from claiming that identity for the first time.
CREATE UNIQUE INDEX IF NOT EXISTS user_kyc_nin_hash_verified_unique
  ON public.user_kyc (nin_hash) WHERE status = 'verified' AND nin_hash IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS user_kyc_bvn_hash_verified_unique
  ON public.user_kyc (bvn_hash) WHERE status = 'verified' AND bvn_hash IS NOT NULL;

-- Single choke point for kyc-verify-nin's upsert. Checks-then-writes inside
-- one SECURITY DEFINER function so the check can't race a concurrent
-- verification of the same identity on a different account -- the unique
-- indexes above are the final backstop if it ever does (caught and
-- reported the same way as an explicitly-detected duplicate).
CREATE OR REPLACE FUNCTION public.record_kyc_verified(
  p_user_id UUID,
  p_nin TEXT,
  p_bvn TEXT,
  p_verified_record JSONB
) RETURNS TABLE (
  ok BOOLEAN,
  duplicate_user_id UUID
)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions AS $$
DECLARE
  v_nin_hash TEXT;
  v_bvn_hash TEXT;
  v_existing_user UUID;
BEGIN
  v_nin_hash := CASE WHEN p_nin IS NOT NULL THEN encode(extensions.digest(convert_to(p_nin, 'UTF8'), 'sha256'), 'hex') ELSE NULL END;
  v_bvn_hash := CASE WHEN p_bvn IS NOT NULL THEN encode(extensions.digest(convert_to(p_bvn, 'UTF8'), 'sha256'), 'hex') ELSE NULL END;

  SELECT uk.user_id INTO v_existing_user
    FROM public.user_kyc uk
   WHERE uk.status = 'verified'
     AND uk.user_id <> p_user_id
     AND ((v_nin_hash IS NOT NULL AND uk.nin_hash = v_nin_hash)
       OR (v_bvn_hash IS NOT NULL AND uk.bvn_hash = v_bvn_hash))
   LIMIT 1;

  IF v_existing_user IS NOT NULL THEN
    RETURN QUERY SELECT false, v_existing_user;
    RETURN;
  END IF;

  BEGIN
    INSERT INTO public.user_kyc (user_id, status, nin, bvn, nin_hash, bvn_hash, verified_record, verified_at, updated_at)
    VALUES (p_user_id, 'verified', p_nin, p_bvn, v_nin_hash, v_bvn_hash, p_verified_record, now(), now())
    ON CONFLICT (user_id) DO UPDATE SET
      status = 'verified', nin = EXCLUDED.nin, bvn = EXCLUDED.bvn,
      nin_hash = EXCLUDED.nin_hash, bvn_hash = EXCLUDED.bvn_hash,
      verified_record = EXCLUDED.verified_record, verified_at = now(), updated_at = now();
  EXCEPTION WHEN unique_violation THEN
    -- The pre-check above raced a concurrent verification of the same
    -- identity that committed first. Re-resolve who actually holds it now.
    SELECT uk.user_id INTO v_existing_user
      FROM public.user_kyc uk
     WHERE uk.status = 'verified' AND uk.user_id <> p_user_id
       AND ((v_nin_hash IS NOT NULL AND uk.nin_hash = v_nin_hash)
         OR (v_bvn_hash IS NOT NULL AND uk.bvn_hash = v_bvn_hash))
     LIMIT 1;
    RETURN QUERY SELECT false, v_existing_user;
    RETURN;
  END;

  RETURN QUERY SELECT true, NULL::UUID;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.record_kyc_verified(UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_kyc_verified(UUID, TEXT, TEXT, JSONB) TO service_role;
