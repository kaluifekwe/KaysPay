-- Kay's Pay: let a user delete their own notifications (single or bulk).
-- =====================================================================
-- Not a money-moving operation (no idempotency/audit-trail requirements
-- like the financial RPCs elsewhere), but still owner-scoped and
-- defensive: only ever deletes rows where user_id = auth.uid(), and
-- silently no-ops on ids that don't belong to the caller (or don't exist)
-- rather than erroring — same spirit as mark_notification_read (migration
-- 050). One array-based RPC covers both single and bulk delete; the
-- client passes a 1-element array for a single delete.
--
-- This does NOT touch the REVOKE INSERT, UPDATE, DELETE ... FROM anon,
-- authenticated from migration 050 (reinforced in 057) — the only new
-- grant is EXECUTE on this RPC, matching how every other client-writable
-- table in this codebase is only ever mutated through SECURITY DEFINER
-- RPCs, never a raw table grant.
-- =====================================================================

CREATE OR REPLACE FUNCTION public.delete_notifications(p_ids UUID[])
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  DELETE FROM notifications WHERE id = ANY(p_ids) AND user_id = auth.uid();
END; $$;

GRANT EXECUTE ON FUNCTION public.delete_notifications(UUID[]) TO authenticated;
