-- Non-sensitive revision rows let active Data screens invalidate their local
-- catalogue immediately when an owner changes availability. No plan details,
-- customer data, transaction data, or admin identity is exposed.
CREATE TABLE public.vtu_availability_revisions (
  network TEXT PRIMARY KEY CHECK (network IN ('mtn','glo','9mobile','airtel')),
  revision BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.vtu_availability_revisions(network)
VALUES ('mtn'), ('glo'), ('9mobile'), ('airtel')
ON CONFLICT (network) DO NOTHING;

ALTER TABLE public.vtu_availability_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vtu_availability_revisions FROM PUBLIC, anon;
GRANT SELECT ON public.vtu_availability_revisions TO authenticated;

CREATE POLICY "Authenticated users can read VTU availability revisions"
  ON public.vtu_availability_revisions FOR SELECT TO authenticated
  USING (true);

CREATE OR REPLACE FUNCTION public.bump_vtu_availability_revision()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_network TEXT;
BEGIN
  v_network := COALESCE(NEW.network, OLD.network);
  UPDATE public.vtu_availability_revisions
  SET revision = revision + 1, updated_at = now()
  WHERE network = v_network;
  RETURN COALESCE(NEW, OLD);
END;
$$;

CREATE TRIGGER trg_bump_vtu_availability_revision
AFTER INSERT OR UPDATE OR DELETE ON public.vtu_plan_controls
FOR EACH ROW EXECUTE FUNCTION public.bump_vtu_availability_revision();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime'
      AND schemaname = 'public'
      AND tablename = 'vtu_availability_revisions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.vtu_availability_revisions;
  END IF;
END $$;
