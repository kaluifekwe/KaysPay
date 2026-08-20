import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createSubAccount, getSubAccounts, QuidaxError } from "./quidax-client.ts";

/**
 * Returns the caller's Quidax sub-account, creating one on first use. A
 * sub-account's email is permanent on Quidax's side once set, so this reads
 * the existing row first and only ever calls Quidax when genuinely missing —
 * never re-creates or re-derives an id that already exists.
 */
/**
 * The name/email Quidax knows this customer by — shared between sub-account
 * creation and anything else that needs to identify the customer TO Quidax
 * (e.g. off-ramp's `initiate`, which compares this name against the payout
 * bank account's registered holder name).
 */
export function deriveQuidaxIdentity(
  user: { id: string; user_metadata?: Record<string, unknown> | null },
): { email: string; firstName: string; lastName: string } {
  // public.users.full_name is never actually populated (see admin-user-lookup) —
  // the real name lives in auth user_metadata, same source used there.
  const fullName = String((user.user_metadata as { full_name?: string } | undefined)?.full_name || "").trim();
  const [firstName, ...rest] = fullName ? fullName.split(/\s+/) : ["KaysPay"];
  const lastName = rest.join(" ") || "User";
  // NEVER the customer's own email. Quidax emails are unique across their
  // WHOLE platform, not just within our sub-accounts — so any customer who
  // already has a personal Quidax account is permanently un-onboardable,
  // failing with "a sub account with this email already exists" that no
  // amount of retrying or lookup can resolve (confirmed live: the owner's
  // own Quidax account holds their email, so their sub-account could never
  // be created). Quidax's own integration docs say to "use your company
  // domain for the email extension" for exactly this reason. Derived from
  // the immutable auth user id so it's stable across retries and devices,
  // and it keeps customer emails out of a third party that has no need for
  // them. The address is a routing-only identifier — no mail is ever sent
  // to it, and the sub-domain is deliberately not the real mail domain.
  const email = `${user.id}@users.kayspay.com.ng`;
  return { email, firstName: firstName.slice(0, 60), lastName: lastName.slice(0, 60) };
}

/**
 * A server-trusted identity for security decisions — unlike
 * deriveQuidaxIdentity() above (fine for sub-account creation, where any
 * display name is harmless), this is for the off-ramp Sell flow's
 * name-match check, which exists specifically to stop a customer's sale
 * proceeds being redirected to someone else's bank account.
 *
 * Found by the 2026-08-20 Strix pentest (vuln-0002/0003): the old code used
 * `auth.user_metadata.full_name` for that check — a field the customer can
 * set to ANY name at signup or in their profile before KYC, so the "name
 * must match" protection was checking the customer's name against itself,
 * not against anything verified. This reads from user_kyc.verified_record
 * instead, which only exists once NIN/BVN verification actually succeeded
 * (see kyc-verify-nin) — returns null (fail closed) if no verified record
 * exists, rather than falling back to the mutable metadata.
 */
export async function deriveVerifiedQuidaxIdentity(
  supabase: SupabaseClient,
  user: { id: string },
): Promise<{ email: string; firstName: string; lastName: string } | null> {
  const { data } = await supabase
    .from("user_kyc")
    .select("status, verified_record")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!data || data.status !== "verified") return null;

  const record = data.verified_record as { firstname?: string; middlename?: string; surname?: string } | null;
  const firstName = String(record?.firstname || "").trim();
  const lastName = [record?.middlename, record?.surname].filter(Boolean).join(" ").trim();
  if (!firstName || !lastName) return null;

  return {
    email: `${user.id}@users.kayspay.com.ng`,
    firstName: firstName.slice(0, 60),
    lastName: lastName.slice(0, 60),
  };
}

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

  const { email, firstName, lastName } = deriveQuidaxIdentity(user);

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
