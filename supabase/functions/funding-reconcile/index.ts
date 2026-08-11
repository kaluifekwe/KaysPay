import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient, verifyCronSecret, withJobLock } from "../_shared/auth.ts";
import { processFundingCandidate } from "../_shared/funding-credit.ts";
import type { FundingProvider } from "../_shared/funding-credit.ts";
import { normalizeFlutterwaveFunding, normalizePaystackFunding } from "../_shared/funding-normalize.ts";
import { listPaystackTransactions } from "../_shared/paystack-client.ts";
import { listFlutterwaveCharges } from "../_shared/flutterwave-client.ts";
import { redactSecrets } from "../_shared/redact.ts";

const OVERLAP_MS = 5 * 60 * 1000;
const INITIAL_LOOKBACK_MS = 60 * 60 * 1000;
const MAX_PAGES_PER_RUN = 5;
function json(body: unknown, status = 200) { return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }); }
type ReconcileState = { provider: FundingProvider; window_from: string | null; window_to: string | null; next_page: number; last_success_at: string | null };

async function loadWindow(db: ReturnType<typeof adminClient>, provider: FundingProvider) {
  const { data, error } = await db.from("funding_reconciliation_state").select("*").eq("provider", provider).single();
  if (error) throw error;
  const state = data as ReconcileState;
  if (state.window_from && state.window_to) return state;
  const now = new Date();
  const previous = state.last_success_at ? new Date(state.last_success_at).getTime() : now.getTime() - INITIAL_LOOKBACK_MS;
  const windowFrom = new Date(Math.max(0, previous - OVERLAP_MS)).toISOString();
  const windowTo = now.toISOString();
  const { data: started, error: startError } = await db.from("funding_reconciliation_state").update({ window_from: windowFrom, window_to: windowTo, next_page: 1, last_run_at: now.toISOString(), last_error: null, updated_at: now.toISOString() }).eq("provider", provider).select("*").single();
  if (startError) throw startError;
  return started as ReconcileState;
}

function recordsFromFlutterwave(response: any): any[] {
  if (Array.isArray(response?.data)) return response.data;
  if (Array.isArray(response?.data?.data)) return response.data.data;
  return [];
}

async function reconcileProvider(db: ReturnType<typeof adminClient>, provider: FundingProvider) {
  const state = await loadWindow(db, provider);
  let page = Math.max(1, Number(state.next_page || 1));
  let pages = 0, seen = 0, credited = 0, duplicate = 0, unmatched = 0;
  let finished = false;
  try {
    while (pages < MAX_PAGES_PER_RUN && !finished) {
      let records: any[];
      let hasMore: boolean;
      if (provider === "paystack") {
        const result = await listPaystackTransactions({ from: state.window_from!, to: state.window_to!, page, perPage: 100 });
        if (result.status >= 400 || result.data?.status !== true) throw new Error("PAYSTACK_LIST_FAILED");
        records = Array.isArray(result.data?.data) ? result.data.data : [];
        const pageCount = Number(result.data?.meta?.pageCount ?? result.data?.meta?.page_count ?? 0);
        hasMore = pageCount > 0 ? page < pageCount : records.length === 100;
      } else {
        const result = await listFlutterwaveCharges(db, { from: state.window_from!, to: state.window_to!, page, size: 50 });
        if (result.status >= 400 || result.data?.status !== "success") throw new Error("FLUTTERWAVE_LIST_FAILED");
        records = recordsFromFlutterwave(result.data);
        const info = result.data?.meta?.page_info ?? result.data?.page_info ?? result.data?.meta ?? {};
        const totalPages = Number(info.total_pages ?? info.page_count ?? 0);
        hasMore = totalPages > 0 ? page < totalPages : records.length === 50;
      }
      for (const record of records) {
        const candidate = provider === "paystack" ? normalizePaystackFunding(record) : normalizeFlutterwaveFunding(record);
        if (!candidate) continue;
        seen++;
        const result = await processFundingCandidate(db, candidate);
        if (result.outcome === "credited") credited++;
        else if (result.outcome === "duplicate") duplicate++;
        else if (result.outcome === "unmatched") unmatched++;
      }
      pages++; page++; finished = !hasMore;
      // Record whether this sweep actually looked at anything. "Ran without
      // error" was never enough to prove the sweep works — a normalizer that
      // rejects every record looks identical to a quiet period unless the
      // sighting itself is tracked. See migration 110.
      const progress: Record<string, unknown> = { next_page: page, last_run_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString(), last_seen_count: seen };
      if (records.length > 0) progress.last_saw_records_at = new Date().toISOString();
      await db.from("funding_reconciliation_state").update(progress).eq("provider", provider);
    }
    if (finished) {
      await db.from("funding_reconciliation_state").update({ last_success_at: state.window_to, window_from: null, window_to: null, next_page: 1, last_run_at: new Date().toISOString(), last_error: null, updated_at: new Date().toISOString() }).eq("provider", provider);
    }
    return { provider, pages, seen, credited, duplicate, unmatched, finished };
  } catch (error) {
    await db.from("funding_reconciliation_state").update({ last_run_at: new Date().toISOString(), last_error: String((error as Error)?.message || "RECONCILIATION_FAILED").slice(0, 200), updated_at: new Date().toISOString() }).eq("provider", provider);
    console.error(`${provider} funding reconciliation failed:`, redactSecrets(error));
    return { provider, pages, seen, credited, duplicate, unmatched, finished: false, error: true };
  }
}

serve(async (req: Request) => {
  if (!verifyCronSecret(req)) return json({ error: "Unauthorized" }, 401);
  const db = adminClient();
  const result = await withJobLock(db, "funding-reconcile", async () => {
    const paystack = await reconcileProvider(db, "paystack");
    const flutterwave = await reconcileProvider(db, "flutterwave");
    return { checked: true, providers: [paystack, flutterwave] };
  });
  return json(result);
});
