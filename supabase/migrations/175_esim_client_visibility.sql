-- Allow the authenticated mobile app to read the eSIM visibility flag.
-- The underlying service_controls table remains service-role-only; this
-- purpose-built RPC exposes only a boolean for explicitly approved services.
CREATE OR REPLACE FUNCTION public.is_client_feature_enabled(p_service TEXT)
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN p_service = ANY (ARRAY['crypto', 'transfer', 'esim'])
    THEN COALESCE((SELECT enabled FROM service_controls WHERE service = p_service), FALSE)
    ELSE FALSE
  END;
$$;

REVOKE ALL ON FUNCTION public.is_client_feature_enabled(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_client_feature_enabled(TEXT) TO authenticated;
