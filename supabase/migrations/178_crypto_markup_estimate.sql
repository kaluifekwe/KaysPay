-- Quidax confirmed (2026-09-01) their merchant markup — the 2% applied on
-- every buy and sell — is only visible on their own dashboard, never via
-- any API response. Checked directly against their own documented example
-- payloads for buy, sell, and fetch-transaction: none carry a markup field.
-- So markup_kobo above stays genuinely uncovered (0% coverage on both sides
-- today), not because anything here is broken, but because Quidax has
-- nothing to give us.
--
-- Two real numbers from their dashboard prove it's not a clean, uniform 2%:
--   NGN 4,017.98 traded -> NGN 82.59 markup  = 2.06%
--   2.53809 USDT traded -> 0.07227 markup    = 2.85%
-- Different percentages, so "amount * 2%" is an ESTIMATE, not a
-- reconstruction of their real number. It must never be presented as
-- confirmed revenue, which is why it lands in its own field
-- (estimated_markup_kobo) rather than being folded into markup_revenue_kobo
-- — the whole report is built around "never estimated" (see its own footer
-- text), and this keeps that promise intact for the one real figure while
-- still giving visibility via a clearly separate approximate one.
--
-- Base: amount_ngn on the transaction row. For a sell this is safe because
-- complete_crypto_sell_offramp (migration 165) writes the SAME value to
-- amount_ngn and metadata.settled_ngn_kobo in one UPDATE — they are
-- identical for every completed sell, so no need to read the metadata
-- field separately. For a buy, amount_ngn already is what the customer
-- paid.
CREATE OR REPLACE FUNCTION public.admin_markup_commission_report(p_start TIMESTAMPTZ,p_end TIMESTAMPTZ) RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
WITH crypto AS (
 SELECT type,status,amount_ngn,
  CASE WHEN type='crypto_buy' AND status='completed' AND metadata->>'merchant_markup_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'merchant_markup_ngn')::numeric*100)::bigint
       WHEN type='crypto_sell' AND status='completed' AND metadata->>'merchant_markup_kobo' ~ '^\d+$' THEN (metadata->>'merchant_markup_kobo')::bigint END markup_kobo,
  CASE WHEN status='completed' THEN round(amount_ngn*0.02)::bigint END estimated_markup_kobo,
  CASE WHEN type='crypto_buy' AND metadata->>'processor_fee_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'processor_fee_ngn')::numeric*100)::bigint
       WHEN type='crypto_sell' AND metadata->>'processor_fee_kobo' ~ '^\d+$' THEN (metadata->>'processor_fee_kobo')::bigint END processor_fee_kobo,
  CASE WHEN type='crypto_buy' AND metadata->>'vat_ngn' ~ '^\d+(\.\d+)?$' THEN round((metadata->>'vat_ngn')::numeric*100)::bigint
       WHEN type='crypto_sell' AND metadata->>'vat_kobo' ~ '^\d+$' THEN (metadata->>'vat_kobo')::bigint END vat_kobo
 FROM transactions WHERE type IN('crypto_buy','crypto_sell') AND created_at>=p_start AND created_at<p_end
), by_type AS (
 SELECT type,count(*) attempts,count(*) FILTER(WHERE status='completed') successful,count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL) markup_covered,
  COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0) successful_volume_kobo,COALESCE(sum(markup_kobo),0) markup_revenue_kobo,
  COALESCE(sum(estimated_markup_kobo),0) estimated_markup_kobo,
  COALESCE(sum(processor_fee_kobo) FILTER(WHERE status='completed'),0) processor_fees_kobo,COALESCE(sum(vat_kobo) FILTER(WHERE status='completed'),0) vat_kobo
 FROM crypto GROUP BY type)
SELECT jsonb_build_object('attempts',count(*),'successful',count(*) FILTER(WHERE status='completed'),'markup_covered',count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL),
 'markup_coverage_percent',COALESCE(round(100.0*count(*) FILTER(WHERE status='completed' AND markup_kobo IS NOT NULL)/nullif(count(*) FILTER(WHERE status='completed'),0),2),0),
 'successful_volume_kobo',COALESCE(sum(amount_ngn) FILTER(WHERE status='completed'),0),'markup_revenue_kobo',COALESCE(sum(markup_kobo),0),
 'estimated_markup_kobo',COALESCE(sum(estimated_markup_kobo),0),
 'processor_fees_kobo',COALESCE(sum(processor_fee_kobo) FILTER(WHERE status='completed'),0),'vat_kobo',COALESCE(sum(vat_kobo) FILTER(WHERE status='completed'),0),
 'services',COALESCE((SELECT jsonb_agg(to_jsonb(by_type) ORDER BY type) FROM by_type),'[]'::jsonb)) FROM crypto;
$$;
REVOKE EXECUTE ON FUNCTION public.admin_markup_commission_report(TIMESTAMPTZ,TIMESTAMPTZ) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.admin_markup_commission_report(TIMESTAMPTZ,TIMESTAMPTZ) TO service_role;
