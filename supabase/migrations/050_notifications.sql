-- 050_notifications.sql
--
-- Real in-app notification feed. A single trigger on `transactions` creates a
-- notification on every meaningful money event (funding received, purchase
-- completed/failed/refunded, withdrawal) so notifications stay centralised —
-- no edge function has to be edited to emit them.
--
-- Money is stored in kobo (BIGINT); notifications show naira.

CREATE TABLE IF NOT EXISTS public.notifications (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL,
  type       TEXT NOT NULL,              -- 'funding' | 'withdrawal' | 'transaction' | 'system'
  data       JSONB,
  read       BOOLEAN NOT NULL DEFAULT FALSE,
  pushed     BOOLEAN NOT NULL DEFAULT FALSE,  -- consumed by the push cron (migration 051)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON public.notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unpushed ON public.notifications (created_at) WHERE pushed = FALSE;

-- Owner can READ their own notifications; all writes go through the trigger
-- (SECURITY DEFINER) or the mark-read RPCs below. No direct client writes.
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "own notifications" ON public.notifications;
CREATE POLICY "own notifications" ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);
REVOKE INSERT, UPDATE, DELETE ON public.notifications FROM anon, authenticated;

-- Mark-read RPCs (owner-scoped) — the only way a client changes a notification.
CREATE OR REPLACE FUNCTION public.mark_notification_read(p_id UUID)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE notifications SET read = TRUE WHERE id = p_id AND user_id = auth.uid();
END; $$;
GRANT EXECUTE ON FUNCTION public.mark_notification_read(UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.mark_all_notifications_read()
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE notifications SET read = TRUE WHERE user_id = auth.uid() AND read = FALSE;
END; $$;
GRANT EXECUTE ON FUNCTION public.mark_all_notifications_read() TO authenticated;

-- Central emitter. Fires when a transaction reaches a terminal state, whether
-- it was inserted that way (e.g. wallet funding) or updated into it (e.g. a
-- purchase completing). The INSERT is exception-wrapped so a notification
-- failure can NEVER roll back the money operation it rides on.
CREATE OR REPLACE FUNCTION public.notify_on_transaction()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_naira TEXT;
  v_label TEXT;
  v_title TEXT;
  v_body  TEXT;
  v_type  TEXT;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS NOT DISTINCT FROM OLD.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status NOT IN ('completed', 'failed', 'refunded') THEN
    RETURN NEW;
  END IF;

  v_naira := '₦' || to_char((COALESCE(NEW.amount_ngn, 0)::NUMERIC / 100), 'FM999,999,990.00');
  v_label := CASE NEW.type
    WHEN 'airtime' THEN 'airtime'
    WHEN 'data' THEN 'data bundle'
    WHEN 'bill' THEN 'bill payment'
    WHEN 'exam_pin' THEN 'exam pin'
    WHEN 'esim' THEN 'eSIM'
    WHEN 'foreign_number' THEN 'foreign number'
    WHEN 'nin_verification' THEN 'NIN verification'
    WHEN 'nin_validation' THEN 'NIN validation'
    ELSE replace(NEW.type, '_', ' ')
  END;

  IF NEW.type = 'wallet_fund' AND NEW.status = 'completed' THEN
    v_type := 'funding'; v_title := 'Wallet funded';
    v_body := v_naira || ' has been added to your wallet.';
  ELSIF NEW.type = 'withdrawal' AND NEW.status = 'completed' THEN
    v_type := 'withdrawal'; v_title := 'Withdrawal successful';
    v_body := v_naira || ' has been sent to your bank account.';
  ELSIF NEW.status = 'refunded' OR NEW.type = 'refund' THEN
    v_type := 'transaction'; v_title := 'Refund processed';
    v_body := v_naira || ' has been refunded to your wallet.';
  ELSIF NEW.status = 'failed' THEN
    v_type := 'transaction'; v_title := 'Transaction failed';
    v_body := 'Your ' || v_label || ' transaction failed. Any amount charged has been refunded.';
  ELSE  -- completed purchase
    v_type := 'transaction'; v_title := 'Purchase successful';
    v_body := 'Your ' || v_label || ' purchase of ' || v_naira || ' was successful.';
  END IF;

  BEGIN
    INSERT INTO notifications (user_id, title, body, type, data)
    VALUES (NEW.user_id, v_title, v_body, v_type,
            jsonb_build_object('transaction_id', NEW.id, 'tx_type', NEW.type, 'status', NEW.status));
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- never let a notification failure break the money path
  END;

  RETURN NEW;
END; $$;

DROP TRIGGER IF EXISTS trg_notify_on_transaction ON public.transactions;
CREATE TRIGGER trg_notify_on_transaction
  AFTER INSERT OR UPDATE OF status ON public.transactions
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_transaction();
