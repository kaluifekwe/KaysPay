-- Resolve customer phone numbers consistently for support searches.
-- Email-signup accounts may have the number in public.users, auth.users.phone,
-- or Auth metadata depending on when the account was created. The function is
-- service-role-only and never exposes auth.users directly to the admin client.
CREATE OR REPLACE FUNCTION public.admin_search_users(p_query TEXT)
RETURNS TABLE(id UUID, full_name TEXT, phone TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT
    u.id,
    NULLIF(au.raw_user_meta_data->>'full_name', ''),
    COALESCE(
      NULLIF(u.phone, ''),
      NULLIF(au.phone, ''),
      NULLIF(au.raw_user_meta_data->>'phone', ''),
      NULLIF(au.raw_user_meta_data->>'phone_number', '')
    ),
    u.created_at
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE COALESCE(
      NULLIF(u.phone, ''),
      NULLIF(au.phone, ''),
      NULLIF(au.raw_user_meta_data->>'phone', ''),
      NULLIF(au.raw_user_meta_data->>'phone_number', ''),
      ''
    ) ILIKE '%' || p_query || '%'
     OR au.raw_user_meta_data->>'full_name' ILIKE '%' || p_query || '%'
  ORDER BY u.created_at DESC
  LIMIT 20
$$;

REVOKE ALL ON FUNCTION public.admin_search_users(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_users(TEXT) TO service_role;

-- Keep the existing detail resolver aligned with the same legacy sources.
CREATE OR REPLACE FUNCTION public.admin_resolve_user_details(p_user_ids UUID[])
RETURNS TABLE(user_id UUID, full_name TEXT, phone TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT
    au.id,
    NULLIF(au.raw_user_meta_data->>'full_name', ''),
    COALESCE(
      NULLIF(u.phone, ''),
      NULLIF(au.phone, ''),
      NULLIF(au.raw_user_meta_data->>'phone', ''),
      NULLIF(au.raw_user_meta_data->>'phone_number', '')
    )
  FROM auth.users au
  LEFT JOIN public.users u ON u.id = au.id
  WHERE au.id = ANY(p_user_ids)
$$;

REVOKE ALL ON FUNCTION public.admin_resolve_user_details(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_user_details(UUID[]) TO service_role;
