import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export type ServicePriceKey =
  | "nin_verify_regular"
  | "nin_verify_card"
  | "nin_modification"
  | "nin_validation"
  | "bvn_verify_regular"
  | "bvn_verify_card";

export interface ServicePricing { priceKobo: number; providerCostKobo: number | null }

export async function getServicePricing(
  db: SupabaseClient,
  key: ServicePriceKey,
  fallbackKobo: number,
): Promise<ServicePricing> {
  const { data } = await db.from("service_pricing").select("price_kobo,provider_cost_kobo").eq("service_key",key).maybeSingle();
  const price=Number(data?.price_kobo),cost=Number(data?.provider_cost_kobo);
  return {
    priceKobo:Number.isFinite(price)&&price>0?price:fallbackKobo,
    providerCostKobo:Number.isFinite(cost)&&cost>0?cost:null,
  };
}

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
  return (await getServicePricing(db,key,fallbackKobo)).priceKobo;
}
