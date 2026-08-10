-- VTUnaija is the sole active VTU provider. Preserve historical transaction,
-- refund, monitoring, and performance rows, but remove retired provider jobs
-- and server-only operational caches.

SELECT cron.unschedule('vtu-reconcile-pending-orders')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtu-reconcile-pending-orders');

SELECT cron.unschedule('vtuafrica-reconcile-pending-orders')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtuafrica-reconcile-pending-orders');

SELECT cron.unschedule('vtung-data-catalog-sync')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'vtung-data-catalog-sync');

DROP TABLE IF EXISTS public.vtung_data_catalog;
DROP TABLE IF EXISTS public.vtu_ng_auth;
