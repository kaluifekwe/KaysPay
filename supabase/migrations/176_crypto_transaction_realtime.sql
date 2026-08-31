-- Crypto Buy completion should reach the waiting customer immediately.
-- Realtime still enforces the existing transactions RLS policies; clients
-- subscribe with a primary-key filter and cannot read another user's row.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime'
       AND schemaname = 'public'
       AND tablename = 'transactions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.transactions;
  END IF;
END $$;
