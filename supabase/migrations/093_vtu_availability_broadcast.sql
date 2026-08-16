-- Broadcast one tiny, public, non-sensitive invalidation message per network
-- change. This fans out once in Realtime instead of authorizing the same
-- Postgres Changes row separately for every active Data-screen subscriber.
CREATE OR REPLACE FUNCTION public.bump_vtu_availability_revision()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, realtime AS $$
DECLARE v_network TEXT;
BEGIN
  v_network := COALESCE(NEW.network, OLD.network);

  UPDATE public.vtu_availability_revisions
  SET revision = revision + 1, updated_at = now()
  WHERE network = v_network;

  PERFORM realtime.send(
    jsonb_build_object('network', v_network),
    'availability_changed',
    concat('vtu-availability:', v_network),
    false
  );

  RETURN COALESCE(NEW, OLD);
END;
$$;

-- The revision rows remain a durable recovery marker, but clients no longer
-- subscribe to their raw Postgres changes after moving to Broadcast.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'vtu_availability_revisions'
  ) THEN
    ALTER PUBLICATION supabase_realtime DROP TABLE public.vtu_availability_revisions;
  END IF;
END $$;
