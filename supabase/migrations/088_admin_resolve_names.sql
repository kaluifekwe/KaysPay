-- The admin panel's transaction/user lists were showing blank names — root
-- cause: public.users.full_name is never actually populated. handle_new_user()
-- (migration 002) only ever inserts (id, phone, pin_hash) at signup, and
-- EditProfileScreen.tsx only updates the name in Supabase Auth's own
-- user_metadata (via supabase.auth.updateUser), never in public.users. The
-- real display name has always lived in auth.users.raw_user_meta_data —
-- which PostgREST can't embed/join directly — so these two SECURITY
-- DEFINER functions read it the same way admin_lookup_user_id_by_email
-- (migration 087) already does.

CREATE FUNCTION public.admin_resolve_user_names(p_user_ids UUID[])
RETURNS TABLE(user_id UUID, full_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT id, NULLIF(raw_user_meta_data->>'full_name', '')
  FROM auth.users WHERE id = ANY(p_user_ids)
$$;
REVOKE EXECUTE ON FUNCTION public.admin_resolve_user_names(UUID[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_resolve_user_names(UUID[]) TO service_role;

CREATE FUNCTION public.admin_search_users(p_query TEXT)
RETURNS TABLE(id UUID, full_name TEXT, phone TEXT, created_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, auth AS $$
  SELECT u.id, NULLIF(au.raw_user_meta_data->>'full_name', ''), u.phone, u.created_at
  FROM public.users u
  JOIN auth.users au ON au.id = u.id
  WHERE u.phone ILIKE '%' || p_query || '%'
     OR au.raw_user_meta_data->>'full_name' ILIKE '%' || p_query || '%'
  ORDER BY u.created_at DESC
  LIMIT 20
$$;
REVOKE EXECUTE ON FUNCTION public.admin_search_users(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_search_users(TEXT) TO service_role;
