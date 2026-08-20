-- Stable customer identity and read-only activity timeline foundation.
-- The subject row deliberately has no FK to auth.users so required audit
-- history can remain attributable after an Auth account is removed.
CREATE TABLE public.customer_subjects (
  subject_id UUID PRIMARY KEY,
  joined_at TIMESTAMPTZ NOT NULL,
  deleted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.customer_subjects(subject_id, joined_at)
SELECT id, created_at FROM public.users
ON CONFLICT(subject_id) DO NOTHING;

ALTER TABLE public.customer_subjects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_subjects FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.customer_subjects TO service_role;

CREATE OR REPLACE FUNCTION public.sync_customer_subject()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    INSERT INTO public.customer_subjects(subject_id,joined_at)
    VALUES(NEW.id,COALESCE(NEW.created_at,now()))
    ON CONFLICT(subject_id) DO UPDATE SET updated_at=now();
    RETURN NEW;
  END IF;

  UPDATE public.customer_subjects
     SET deleted_at=COALESCE(deleted_at,now()),updated_at=now()
   WHERE subject_id=OLD.id;
  RETURN OLD;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.sync_customer_subject() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS trg_sync_customer_subject_insert ON public.users;
CREATE TRIGGER trg_sync_customer_subject_insert
AFTER INSERT ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_customer_subject();
DROP TRIGGER IF EXISTS trg_sync_customer_subject_delete ON public.users;
CREATE TRIGGER trg_sync_customer_subject_delete
BEFORE DELETE ON public.users FOR EACH ROW EXECUTE FUNCTION public.sync_customer_subject();

-- Reserved append-only stream for events that do not already have an
-- authoritative source table. Phase 3 reads existing source tables directly;
-- later instrumentation can write here without redesigning the admin API.
CREATE TABLE public.customer_activity_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  subject_id UUID NOT NULL REFERENCES public.customer_subjects(subject_id),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  category TEXT NOT NULL CHECK(category IN ('account','financial','security','service','admin')),
  event_type TEXT NOT NULL CHECK(event_type ~ '^[a-z0-9_]{3,64}$'),
  outcome TEXT CHECK(outcome IS NULL OR outcome ~ '^[a-z0-9_]{2,32}$'),
  source TEXT NOT NULL CHECK(source ~ '^[a-z0-9_-]{2,64}$'),
  entity_type TEXT CHECK(entity_type IS NULL OR entity_type ~ '^[a-z0-9_]{2,64}$'),
  entity_id TEXT,
  summary TEXT NOT NULL CHECK(length(summary) BETWEEN 3 AND 200),
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB CHECK(length(metadata::TEXT)<=1024),
  actor_type TEXT NOT NULL DEFAULT 'system' CHECK(actor_type IN ('customer','admin','system','provider')),
  actor_id UUID
);
CREATE INDEX idx_customer_activity_subject_time
  ON public.customer_activity_events(subject_id,occurred_at DESC,id DESC);
ALTER TABLE public.customer_activity_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.customer_activity_events FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT ON public.customer_activity_events TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.customer_activity_events_id_seq TO service_role;

-- A single bounded, sanitized timeline over existing authoritative records.
-- No recipient, account number, KYC record, token, device hash, IP, or raw
-- provider payload is returned.
CREATE OR REPLACE FUNCTION public.admin_customer_activity(
  p_subject_id UUID,
  p_from TIMESTAMPTZ DEFAULT NULL,
  p_to TIMESTAMPTZ DEFAULT NULL,
  p_category TEXT DEFAULT NULL,
  p_outcome TEXT DEFAULT NULL,
  p_before TIMESTAMPTZ DEFAULT NULL,
  p_before_key TEXT DEFAULT NULL,
  p_limit INT DEFAULT 51
) RETURNS TABLE(
  event_key TEXT, occurred_at TIMESTAMPTZ, category TEXT, event_type TEXT,
  outcome TEXT, source TEXT, entity_type TEXT, entity_id TEXT, summary TEXT,
  metadata JSONB, actor_type TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH timeline AS (
    SELECT 'account:'||s.subject_id::TEXT AS event_key,s.joined_at AS occurred_at,
      'account'::TEXT AS category,'account_created'::TEXT AS event_type,
      'completed'::TEXT AS outcome,'users'::TEXT AS source,'customer'::TEXT AS entity_type,
      s.subject_id::TEXT AS entity_id,'Account created'::TEXT AS summary,
      '{}'::JSONB AS metadata,'customer'::TEXT AS actor_type
    FROM public.customer_subjects s WHERE s.subject_id=p_subject_id

    UNION ALL
    SELECT 'account_deleted:'||s.subject_id::TEXT,s.deleted_at,'account','account_deleted',
      'completed','users','customer',s.subject_id::TEXT,'Account deleted','{}'::JSONB,'customer'
    FROM public.customer_subjects s WHERE s.subject_id=p_subject_id AND s.deleted_at IS NOT NULL

    UNION ALL
    SELECT 'transaction:'||t.id::TEXT,t.created_at,'financial',t.type,t.status,
      COALESCE(NULLIF(t.metadata->>'provider',''),'kayspay'),'transaction',t.id::TEXT,
      initcap(replace(t.type,'_',' '))||' transaction created',
      jsonb_strip_nulls(jsonb_build_object('amount_kobo',t.amount_ngn,'network',NULLIF(t.network,'N/A'))),
      'customer'
    FROM public.transactions t WHERE t.user_id=p_subject_id

    UNION ALL
    SELECT 'audit:'||a.id::TEXT,a.occurred_at,'financial',
      CASE WHEN a.action='UPDATE' THEN 'transaction_status_changed' ELSE 'transaction_recorded' END,
      a.new_status,'database','transaction',a.row_id::TEXT,
      CASE WHEN a.action='UPDATE' THEN initcap(replace(COALESCE(a.type,'transaction'),'_',' '))||' changed from '||COALESCE(a.old_status,'unknown')||' to '||COALESCE(a.new_status,'unknown')
           ELSE initcap(replace(COALESCE(a.type,'transaction'),'_',' '))||' recorded' END,
      jsonb_strip_nulls(jsonb_build_object('amount_kobo',a.amount_ngn,'old_status',a.old_status,'new_status',a.new_status)),
      'system'
    FROM public.audit_log a WHERE a.user_id=p_subject_id AND a.action='UPDATE'

    UNION ALL
    SELECT 'security:'||e.id::TEXT,e.created_at,'security',e.event_type,
      CASE WHEN e.event_type LIKE '%failed%' OR e.event_type LIKE '%lockout%' THEN 'failed' ELSE 'recorded' END,
      e.source,'security_event',e.id::TEXT,initcap(replace(e.event_type,'_',' ')),e.metadata,'system'
    FROM public.security_events e WHERE e.user_id=p_subject_id

    UNION ALL
    SELECT 'service:'||l.id::TEXT,l.created_at,'service',
      regexp_replace(lower(l.service_type),'[^a-z0-9_]+','_','g'),l.action,
      COALESCE(NULLIF(l.provider,''),'mobile'),'service_log',l.id::TEXT,
      initcap(replace(l.service_type,'_',' '))||' '||l.action,
      jsonb_strip_nulls(jsonb_build_object('provider',l.provider,'network',l.network_type)),
      'customer'
    FROM public.service_logs l WHERE l.user_id=p_subject_id

    UNION ALL
    SELECT 'session:'||d.id::TEXT,d.created_at,'security','device_session_registered','completed',
      'device-sessions','device_session',d.id::TEXT,'Device session registered',
      jsonb_build_object('platform',d.platform,'device_name',left(d.device_name,100)),'customer'
    FROM public.device_sessions d WHERE d.user_id=p_subject_id

    UNION ALL
    SELECT 'session_revoked:'||d.id::TEXT,d.revoked_at,'security','device_session_revoked','completed',
      'device-sessions','device_session',d.id::TEXT,'Device session revoked',
      jsonb_build_object('platform',d.platform),'admin'
    FROM public.device_sessions d WHERE d.user_id=p_subject_id AND d.revoked_at IS NOT NULL

    UNION ALL
    SELECT 'admin:'||a.id::TEXT,a.created_at,'admin',
      regexp_replace(lower(a.action_type),'[^a-z0-9_]+','_','g'),'completed','admin-panel',
      a.target_type,a.target_id,initcap(replace(a.action_type,'_',' ')),
      jsonb_strip_nulls(jsonb_build_object('reason',a.reason)),'admin'
    FROM public.admin_actions a
    WHERE a.target_id=p_subject_id::TEXT OR a.metadata->>'user_id'=p_subject_id::TEXT

    UNION ALL
    SELECT 'event:'||e.id::TEXT,e.occurred_at,e.category,e.event_type,e.outcome,e.source,
      e.entity_type,e.entity_id,e.summary,e.metadata,e.actor_type
    FROM public.customer_activity_events e WHERE e.subject_id=p_subject_id
  )
  SELECT * FROM timeline t
  WHERE (p_from IS NULL OR t.occurred_at>=p_from)
    AND (p_to IS NULL OR t.occurred_at<=p_to)
    AND (p_category IS NULL OR t.category=p_category)
    AND (p_outcome IS NULL OR t.outcome=p_outcome)
    AND (p_before IS NULL OR (t.occurred_at,t.event_key)<(p_before,COALESCE(p_before_key,'')))
  ORDER BY t.occurred_at DESC,t.event_key DESC
  LIMIT LEAST(GREATEST(p_limit,1),101)
$$;
REVOKE EXECUTE ON FUNCTION public.admin_customer_activity(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TIMESTAMPTZ,TEXT,INT) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_customer_activity(UUID,TIMESTAMPTZ,TIMESTAMPTZ,TEXT,TEXT,TIMESTAMPTZ,TEXT,INT) TO service_role;
