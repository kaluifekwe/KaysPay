import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createSubAccount, getSubAccounts, QuidaxError } from "./quidax-client.ts";

/**
 * Returns the caller's Quidax sub-account, creating one on first use. A
 * sub-account's email is permanent on Quidax's side once set, so this reads
 * the existing row first and only ever calls Quidax when genuinely missing —
 * never re-creates or re-derives an id that already exists.
 */
export async function getOrCreateCryptoAccount(
  supabase: SupabaseClient,
  user: { id: string; email?: string | null; user_metadata?: Record<string, unknown> | null },
): Promise<{ quidaxUserId: string; quidaxSn: string | null }> {
  const { data: existing } = await supabase
    .from("crypto_accounts")
    .select("quidax_user_id, quidax_sn")
    .eq("user_id", user.id)
    .maybeSingle();
  if (existing) return { quidaxUserId: existing.quidax_user_id, quidaxSn: existing.quidax_sn };

  // public.users.full_name is never actually populated (see admin-user-lookup) —
  // the real name lives in auth user_metadata, same source used there.
  const fullName = String((user.user_metadata as { full_name?: string } | undefined)?.full_name || "").trim();
  const [firstName, ...rest] = fullName ? fullName.split(/\s+/) : ["KaysPay"];
  const lastName = rest.join(" ") || "User";
  const email = user.email || `${user.id}@kayspay.com.ng`;

  let account: { id: string; sn: string; email: string };
  try {
    account = await createSubAccount({
      email,
      firstName: firstName.slice(0, 60),
      lastName: lastName.slice(0, 60),
    });
  } catch (e) {
    // Recoverable: a prior attempt already created this sub-account on
    // Quidax's side but the local crypto_accounts row never landed (a
    // crashed request, a transient DB error, or a retry against an
    // about-to-be-fixed API key that got further than the others did).
    // Quidax's email->sub-account mapping is permanent, so the fix is to
    // find the existing one, not fail forever on every future visit.
    const alreadyExists = e instanceof QuidaxError
      && (e.status === 409 || /already exists/i.test(e.message));
    if (!alreadyExists) throw e;

    const subAccounts = await getSubAccounts();
    const found = subAccounts.find((s) => s.email.toLowerCase() === email.toLowerCase());
    if (!found) throw e;
    account = found;
  }

  const { error } = await supabase.from("crypto_accounts").insert({
    user_id: user.id,
    quidax_user_id: account.id,
    quidax_sn: account.sn,
  });
  // A concurrent request may have won the insert race — re-read rather than
  // fail, since the sub-account creation itself already succeeded either way.
  if (error) {
    const { data: raced } = await supabase
      .from("crypto_accounts")
      .select("quidax_user_id, quidax_sn")
      .eq("user_id", user.id)
      .maybeSingle();
    if (raced) return { quidaxUserId: raced.quidax_user_id, quidaxSn: raced.quidax_sn };
    throw error;
  }

  return { quidaxUserId: account.id, quidaxSn: account.sn };
}
