import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { corsHeaders, handleCors } from "../_shared/cors.ts";
import { getAuthUser, adminClient, consumeAuthToken } from "../_shared/auth.ts";

const PAYSTACK_SECRET = Deno.env.get("PAYSTACK_SECRET_KEY");

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  const cors = handleCors(req);
  if (cors) return cors;

  try {
    if (!PAYSTACK_SECRET) return json({ error: "Paystack secret key not configured" }, 500);

    // The withdrawing user comes from the JWT — NEVER from the body.
    const user = await getAuthUser(req);
    if (!user) return json({ error: "Unauthorized" }, 401);

    const { amount, account_number, bank_code, account_name, bank_name, idempotency_key, auth_token } =
      await req.json();

    if (!amount || !account_number || !bank_code || !account_name || !bank_name) {
      return json({ error: "Missing required fields" }, 400);
    }
    // amount is in kobo (integer).
    if (!Number.isInteger(amount) || amount <= 0) {
      return json({ error: "Invalid amount" }, 400);
    }

    const supabase = adminClient();

    // Require server-verified proof the PIN/biometric step-up just ran for
    // THIS request — a valid JWT alone is not enough to move money.
    const authorized = await consumeAuthToken(supabase, user.id, auth_token);
    if (!authorized) return json({ error: "Re-authorization required. Please try again." }, 401);

    const reference = `KPWD_${Date.now()}_${user.id.substring(0, 8)}`;

    // 1. Atomically debit + create withdrawal/transaction records (idempotent).
    const { data: debit, error: debitError } = await supabase.rpc("debit_for_withdrawal", {
      p_user_id: user.id,
      p_amount: amount,
      p_reference: reference,
      p_bank_name: bank_name,
      p_bank_code: bank_code,
      p_account_number: account_number,
      p_account_name: account_name,
      p_idempotency_key: idempotency_key || null,
    });

    if (debitError) {
      const msg = debitError.message || "";
      if (msg.includes("INSUFFICIENT_FUNDS")) return json({ error: "Insufficient balance" }, 402);
      if (msg.includes("WALLET_NOT_FOUND")) return json({ error: "Wallet not found" }, 400);
      return json({ error: "Could not start withdrawal" }, 500);
    }

    const newBalance = (debit as any).balance;
    const withdrawalId = (debit as any).withdrawal_id;

    // Replay of a withdrawal we already processed: return its current state,
    // do NOT debit or call Paystack again.
    if ((debit as any).replay) {
      return json({
        status: true,
        data: {
          reference: (debit as any).reference,
          status: (debit as any).status,
          new_balance: newBalance,
          withdrawal_id: withdrawalId,
          replayed: true,
        },
      });
    }

    // 2. Create Paystack transfer recipient.
    const recipientRes = await fetch("https://api.paystack.co/transferrecipient", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "nuban",
        name: account_name,
        account_number,
        bank_code,
        currency: "NGN",
      }),
    });
    const recipientData = await recipientRes.json();

    if (!recipientData.status) {
      await supabase.rpc("refund_withdrawal_by_reference", {
        p_reference: reference,
        p_reason: "recipient_creation_failed",
      });
      return json({ error: recipientData.message || "Failed to create transfer recipient" }, 400);
    }

    // 3. Initiate the transfer.
    const transferRes = await fetch("https://api.paystack.co/transfer", {
      method: "POST",
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        source: "balance",
        amount, // already in kobo
        recipient: recipientData.data.recipient_code,
        reference,
        reason: `Kay's Pay withdrawal to ${bank_name}`,
      }),
    });
    const transferData = await transferRes.json();

    if (!transferData.status) {
      await supabase.rpc("refund_withdrawal_by_reference", {
        p_reference: reference,
        p_reason: "transfer_init_failed",
      });
      return json({ error: transferData.message || "Transfer failed" }, 400);
    }

    // 4. Record the transfer code (final settlement comes via webhook).
    await supabase
      .from("withdrawals")
      .update({ paystack_transfer_code: transferData.data.transfer_code })
      .eq("id", withdrawalId);

    return json({
      status: true,
      data: {
        reference,
        transfer_code: transferData.data.transfer_code,
        status: transferData.data.status,
        new_balance: newBalance,
        withdrawal_id: withdrawalId,
      },
    });
  } catch (error) {
    return json({ error: (error as Error).message || "Internal server error" }, 500);
  }
});
