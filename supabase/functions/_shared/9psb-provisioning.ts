import { adminClient } from "./auth.ts";
import { getWallet, identityInitiate } from "./9psb-client.ts";

// Shared "Call 1" logic (getWallet dedup check + identityInitiate + a
// pending_identity row) — used both by 9psb-create-wallet's own Call 1
// endpoint and by kyc-verify-nin's auto-provisioning hook, so a customer's
// wallet setup can be kicked off automatically the moment KYC completes,
// with zero duplicated logic between the two call sites.

export type ProvisioningStartResult =
  | { outcome: "already_active"; account: { account_number: string; bank_name: string; account_name: string } }
  | { outcome: "pending"; transactionRef: string }
  | { outcome: "started"; transactionRef: string }
  | { outcome: "error"; message: string };

export async function startNinePsbProvisioning(
  supabase: ReturnType<typeof adminClient>,
  params: { userId: string; verifiedIdentifier: string; usingNin: boolean; phone?: string },
): Promise<ProvisioningStartResult> {
  const { data: existing } = await supabase
    .from("virtual_accounts")
    .select("status, account_number, bank_name, account_name, customer_code")
    .eq("user_id", params.userId)
    .eq("provider", "9psb")
    .maybeSingle();

  if (existing?.status === "active" && existing.account_number) {
    return {
      outcome: "already_active",
      account: { account_number: existing.account_number, bank_name: existing.bank_name, account_name: existing.account_name },
    };
  }
  if (existing?.status === "pending_identity" && existing.customer_code) {
    return { outcome: "pending", transactionRef: existing.customer_code };
  }

  // Avoid 9PSB's duplicate-wallet error (response code 94) on a retried or
  // previously-interrupted setup.
  const lookup = await getWallet(
    supabase,
    params.usingNin ? { nin: params.verifiedIdentifier } : { bvn: params.verifiedIdentifier },
  );
  const alreadyOpen = lookup.status < 400 && Array.isArray(lookup.data?.data?.wallet) && lookup.data.data.wallet[0];
  if (alreadyOpen) {
    const w = alreadyOpen;
    const account = {
      account_number: String(w.accountNumber || w.account_number),
      bank_name: "9 Payment Service Bank",
      account_name: String(w.accountName || w.account_name || ""),
    };
    const { error: upsertError } = await supabase.from("virtual_accounts").upsert({
      user_id: params.userId,
      provider: "9psb",
      status: "active",
      account_number: account.account_number,
      bank_name: account.bank_name,
      account_name: account.account_name,
    }, { onConflict: "user_id,provider" });
    if (upsertError) return { outcome: "error", message: upsertError.message };
    return { outcome: "already_active", account };
  }

  const transactionRef = `9psb${params.userId.replace(/-/g, "")}${Date.now()}`;
  const initRes = await identityInitiate(supabase, {
    transactionRef,
    nin: params.usingNin ? params.verifiedIdentifier : undefined,
    bvn: params.usingNin ? undefined : params.verifiedIdentifier,
    phoneNo: params.phone,
    type: "OTP",
  });
  if (initRes.status >= 400 || initRes.data?.status !== "SUCCESS") {
    return { outcome: "error", message: initRes.data?.message || `identity/initiate failed (status ${initRes.status})` };
  }

  const { error: pendingError } = await supabase.from("virtual_accounts").upsert({
    user_id: params.userId,
    provider: "9psb",
    status: "pending_identity",
    customer_code: transactionRef,
  }, { onConflict: "user_id,provider" });
  if (pendingError) return { outcome: "error", message: pendingError.message };

  return { outcome: "started", transactionRef };
}
