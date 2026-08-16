-- Structured, append-only audit trail for every financial state change
-- (item 4 of the 2026-08-06 security audit follow-up). Implemented as a
-- trigger on `transactions` rather than editing any of the existing
-- money-moving RPCs (debit_for_service, buy_crypto, etc.) — every debit/
-- credit in this codebase always inserts or updates a transactions row in
-- the SAME database transaction as the balance change, so this single
-- trigger captures every financial event without touching a single line
-- of already-tested purchase/withdrawal logic.
CREATE TABLE public.audit_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  table_name  TEXT NOT NULL,
  row_id      UUID NOT NULL,
  action      TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE')),
  user_id     UUID,
  type        TEXT,
  amount_ngn  BIGINT,
  old_status  TEXT,
  new_status  TEXT,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (length(metadata::TEXT) <= 512)
);
CREATE INDEX idx_audit_log_row ON public.audit_log(row_id);
CREATE INDEX idx_audit_log_user ON public.audit_log(user_id, occurred_at DESC);

ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;
-- Append-only, server-only — same posture as every other internal table
-- here (email_verification_codes, transaction_auth_tokens, etc.). No
-- policies at all means default-deny to anon/authenticated; only
-- service_role (which bypasses RLS) can ever read it, and only the
-- trigger below ever writes to it.
REVOKE ALL ON public.audit_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.audit_log TO service_role;

-- Only a SAFE, small subset of metadata is copied — never the full blob
-- (which can carry large/sensitive provider payloads) — just enough to
-- trace an event back to its provider/idempotency key.
CREATE OR REPLACE FUNCTION public.log_transaction_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO audit_log (table_name, row_id, action, user_id, type, amount_ngn, old_status, new_status, metadata)
  VALUES (
    'transactions', NEW.id, TG_OP, NEW.user_id, NEW.type, NEW.amount_ngn,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.status ELSE NULL END,
    NEW.status,
    jsonb_build_object(
      'idempotency_key', NEW.metadata->>'idempotency_key',
      'provider', NEW.metadata->>'provider'
    )
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_transactions_audit
  AFTER INSERT OR UPDATE ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.log_transaction_audit();
