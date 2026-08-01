-- Supabase installs pgcrypto in the extensions schema. Keep a fixed, explicit
-- search path while allowing enforce_abuse_rate_limit to resolve digest().
ALTER FUNCTION public.enforce_abuse_rate_limit(TEXT, TEXT, INT, INT, UUID)
  SET search_path = public, extensions;
