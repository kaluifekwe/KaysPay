-- The 300 naira VTUnaija charges per top-up only ever gets counted if
-- someone remembers to log a second, separate ledger entry every time they
-- log the funding itself -- the exact kind of manual step this session has
-- already found forgotten more than once elsewhere in this app (the OTP
-- resend guard, the app-lock timestamp). Recording only the funding and
-- skipping the fee is precisely what made VTUnaija's first-ever
-- reconciliation misreport a 760.30 gap that was mostly just an unlogged,
-- already-known cost.
--
-- So this can't be forgotten: any wallet_funding entry recorded for
-- VTUnaija automatically gets its matching 300 naira funding_fee entry
-- inserted alongside it, same timestamp, same admin attributed. If
-- VTUnaija's fee ever changes, update FUNDING_FEE_KOBO below -- it only
-- affects fundings logged after the change; past entries keep whatever fee
-- was correct for them.
CREATE OR REPLACE FUNCTION public.auto_log_vtunaija_funding_fee() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  FUNDING_FEE_KOBO CONSTANT BIGINT := 30000; -- NGN 300, confirmed with the owner 2026-09-01
BEGIN
  IF NEW.entry_type='wallet_funding' AND NEW.provider='vtunaija' THEN
    INSERT INTO public.provider_finance_entries(provider,entry_type,amount_kobo,notes,occurred_at,created_by)
    VALUES('vtunaija','funding_fee',FUNDING_FEE_KOBO,'Auto-logged: VTUnaija charges 300 per funding top-up',NEW.occurred_at,NEW.created_by);
  END IF;
  RETURN NEW;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.auto_log_vtunaija_funding_fee() FROM PUBLIC,anon,authenticated;

DROP TRIGGER IF EXISTS trg_auto_log_vtunaija_funding_fee ON public.provider_finance_entries;
CREATE TRIGGER trg_auto_log_vtunaija_funding_fee
AFTER INSERT ON public.provider_finance_entries
FOR EACH ROW EXECUTE FUNCTION public.auto_log_vtunaija_funding_fee();
