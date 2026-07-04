import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { adminClient } from "../_shared/auth.ts";
import { queryESIMAccessOrder, isESIMAccessConfigured } from "../_shared/esimaccess-client.ts";

// Scheduled sweep (same pattern as vtu-reconcile, see migration 016) that
// resolves eSIM Access orders left 'pending' after esim-purchase's
// synchronous call returned before the profile finished allocating
// (eSIM Access's own docs: "expect wait times of up to 30 seconds").
// Only ever transitions 'pending' -> 'completed'/'refunded' based on eSIM
// Access's own reported esimStatus — never guesses, never touches
// non-eSIM-Access transactions (identified by metadata.order_no, which only
// the eSIM Access branch of esim-purchase sets).

// esimStatus values that mean "not resolved yet, check again next sweep".
const NON_TERMINAL = ["CREATE", "PAYING", "PAID", "GETTING_RESOURCE"];
// Anything else (GOT_RESOURCE, IN_USE, USED_UP) counts as delivered — the
// eSIM profile exists and is usable, regardless of whether it's been
// installed/used yet.

serve(async () => {
  if (!isESIMAccessConfigured()) {
    return new Response(JSON.stringify({ checked: 0, reason: "eSIM Access not configured" }), { status: 200 });
  }

  const supabase = adminClient();

  const cutoff = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString();
  const { data: pending, error } = await supabase
    .from("transactions")
    .select("id, metadata")
    .eq("status", "pending")
    .eq("type", "esim")
    .not("metadata->>order_no", "is", null)
    .gte("created_at", cutoff)
    .limit(50);

  if (error) {
    return new Response(JSON.stringify({ checked: 0, error: error.message }), { status: 200 });
  }

  let completed = 0;
  let refunded = 0;
  let stillPending = 0;

  for (const tx of pending || []) {
    const orderNo = tx.metadata?.order_no;
    if (!orderNo) continue;

    try {
      const result = await queryESIMAccessOrder(orderNo);
      if (result?.success !== true) continue; // couldn't get a real answer this round

      const esim = result?.obj?.esimList?.[0];
      const status = esim?.esimStatus;

      if (!status || status === "CANCEL") {
        await supabase.rpc("refund_service_transaction", { p_tx_id: tx.id, p_reason: status || "no_profile_allocated" });
        refunded++;
      } else if (NON_TERMINAL.includes(status)) {
        stillPending++;
      } else {
        // Capture the QR/activation details now — this is the only chance
        // to store them; nothing else ever fetches this eSIM's data again.
        await supabase
          .from("transactions")
          .update({
            metadata: {
              ...tx.metadata,
              iccid: esim?.iccid,
              ac: esim?.ac,
              qr_code_url: esim?.qrCodeUrl,
            },
          })
          .eq("id", tx.id);
        await supabase.rpc("complete_service_transaction", { p_tx_id: tx.id, p_order_id: orderNo });
        completed++;
      }
    } catch {
      stillPending++; // network hiccup this round — next sweep will retry
    }
  }

  return new Response(
    JSON.stringify({ checked: pending?.length ?? 0, completed, refunded, stillPending }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
});
