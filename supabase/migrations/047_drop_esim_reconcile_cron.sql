-- 047_drop_esim_reconcile_cron.sql
--
-- Removes the eSIM Access reconciliation cron. eSIM Access was the old eSIM
-- provider, replaced by Airalo (now the sole provider). Airalo orders are
-- SYNCHRONOUS — the QR/activation details come back in the /v2/orders response
-- itself — so there are no 'pending' eSIM orders left to sweep, and the
-- esim-reconcile function + this cron only ever served the eSIM Access flow.
--
-- The esim-reconcile Edge Function and _shared/esimaccess-client.ts are
-- deleted in the same change; the ESIMACCESS_ACCESS_CODE secret is removed
-- separately. Nothing else references these objects.

DO $$
BEGIN
  PERFORM cron.unschedule('esim-reconcile-pending-orders');
EXCEPTION
  WHEN OTHERS THEN NULL;
END $$;
