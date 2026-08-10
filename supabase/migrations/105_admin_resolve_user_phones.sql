-- Resolve phone numbers for admin support views without exposing auth.users.
-- Older email-signup accounts can have the phone only in auth metadata.

CREATE OR REPLACE FUNCTION public.admin_resolve_user_details(p_user_ids UUID[])
RETURNS TABLE(user_id UUID, full_name TEXT, phone TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT
    au.id,
    NULLIF(au.raw_user_meta_data->>'full_name', ''),
    COALESCE(
      NULLIF(u.phone, ''),
      NULLIF(au.phone, ''),
      NULLIF(au.raw_user_meta_data->>'phone', '')
    )
  FROM auth.users au
  LEFT JOIN public.users u ON u.id = au.id
  WHERE au.id = ANY(p_user_ids)
$$;

REVOKE EXECUTE ON FUNCTION public.admin_resolve_user_details(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_user_details(UUID[]) TO service_role;

-- Backfill only unambiguous, currently unclaimed phone numbers. Duplicate or
-- conflicting legacy metadata is deliberately left untouched for manual review.
WITH candidates AS (
  SELECT
    u.id,
    COALESCE(NULLIF(au.phone, ''), NULLIF(au.raw_user_meta_data->>'phone', '')) AS phone
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE NULLIF(u.phone, '') IS NULL
), unique_candidates AS (
  SELECT phone
  FROM candidates
  WHERE phone IS NOT NULL
  GROUP BY phone
  HAVING COUNT(*) = 1
)
UPDATE public.users AS u
SET phone = c.phone
FROM candidates c
JOIN unique_candidates uc ON uc.phone = c.phone
WHERE u.id = c.id
  AND NOT EXISTS (
    SELECT 1 FROM public.users existing
    WHERE existing.id <> u.id AND existing.phone = c.phone
  );
