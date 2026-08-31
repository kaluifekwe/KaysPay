-- Let the authenticated mobile app read only the Transfer visibility flag.
--
-- The underlying service_controls table remains service-role-only. This RPC
-- deliberately returns a boolean for an explicit allowlist and exposes none
-- of the admin-only reason or audit metadata. Transfer execution continues to
-- enforce the same switch server-side, so this is a UX visibility surface,
-- not the financial security boundary.
CREATE OR REPLACE FUNCTION public.is_client_feature_enabled(p_service TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_service = ANY (ARRAY['crypto', 'transfer'])
    THEN COALESCE((SELECT enabled FROM service_controls WHERE service = p_service), FALSE)
    ELSE FALSE
  END;
$$;

REVOKE ALL ON FUNCTION public.is_client_feature_enabled(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_client_feature_enabled(TEXT) TO authenticated;
