-- One-time cleanup for the unusable zero-recipient AI draft approved for cancellation.
WITH target AS (
  SELECT c.id
  FROM public.marketing_campaigns c
  WHERE c.status='draft'
    AND c.ai_request_id IS NOT NULL
    AND c.segment='registered_not_verified'
    AND c.name LIKE 'AI recovery · registered customers awaiting email verification · %'
    AND NOT EXISTS (
      SELECT 1
      FROM public.marketing_segment_members(c.segment,c.inactivity_days) m
    )
  ORDER BY c.created_at DESC
  LIMIT 1
)
UPDATE public.marketing_campaigns c
SET status='cancelled',updated_at=now()
FROM target
WHERE c.id=target.id;
