import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type ServicePriceKey =
  | "nin_verify_regular"
  | "nin_verify_card"
  | "nin_modification"
  | "nin_validation"
  | "bvn_verify_regular"
  | "bvn_verify_card";

// Admin-settable price (see migration 112 + admin-pricing-controls), read
// fresh on every call so a price change takes effect on the very next
// purchase. Falls back to the caller-supplied default (the price shipped in
// code before this existed) if the row is ever missing — a lookup failure
// can never silently break a purchase or charge nothing.
export async function getServicePriceKobo(
  db: SupabaseClient,
  key: ServicePriceKey,
  fallbackKobo: number,
): Promise<number> {
  const { data } = await db
    .from("service_pricing")
    .select("price_kobo")
    .eq("service_key", key)
    .maybeSingle();
  const price = Number(data?.price_kobo);
  return Number.isFinite(price) && price > 0 ? price : fallbackKobo;
}
