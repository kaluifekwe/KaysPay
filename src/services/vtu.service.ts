import { supabase } from '../lib/supabase';
import { nairaToKobo } from '../utils/formatCurrency';
import { withTimeout, invokeWithRetry } from '../utils/network';

export type NetworkProvider = 'mtn' | 'airtel' | 'glo' | '9mobile';

export interface DataBundle {
  id: string;
  name: string;
  amount: number;
  validity: string;
  network: NetworkProvider;
}

export interface ElectricityProvider {
  id: string;
  name: string;
  type: 'prepaid' | 'postpaid';
}

export interface TVProvider {
  id: string;
  name: string;
  bouquets: { id: string; name: string; amount: number }[];
}

export interface ExamType {
  id: string;
  name: string;
  amount: number;
  quantity_options: number[];
  requiresProfileCode?: boolean;
}

export interface VTUResult {
  success: boolean;
  order_id?: string;
  message?: string;
  error?: string;
  // VTU.ng's v2 API can be async — the order may still be processing when
  // the request returns. `pending` means "not failed, just not final yet";
  // it'll complete or refund on its own shortly after.
  pending?: boolean;
  // The server transaction id — lets the result screen poll this purchase
  // until it settles (used by the Processing -> Successful status screen).
  transaction_id?: string;
}

export interface BatchAirtimeRecipient {
  phone: string;
  network: NetworkProvider;
  amount: number; // naira
}

export interface BatchDataRecipient {
  phone: string;
  network: NetworkProvider;
  bundle: DataBundle;
}

export interface BatchResultItem {
  phone: string;
  success: boolean;
  // The provider now settles in the background, so a freshly-submitted order
  // comes back success+pending: accepted, not yet confirmed delivered. The
  // bulk screen polls `transaction_id` until it flips to a terminal state so a
  // later refund is never hidden behind a premature ✓.
  pending?: boolean;
  transaction_id?: string;
  order_id?: string;
  error?: string;
}

const airtimeAmounts = [100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 15000, 20000];

// Real, live catalog from VTUAfrica's own Data Bundle API docs page
// (confirmed live, 2026-07-03). IDs match the server catalog exactly
// (`{network}-{category}-{planCode}`). Only plans marked "Active" on
// VTUAfrica's side are listed. Zero markup — customers pay exactly
// VTUAfrica's confirmed Portal Owner cost, same policy as Glo already had.
const dataBundles: DataBundle[] = [
  // MTN
  { id: 'mtn-sme-500w', name: '500MB (SME)', amount: 330, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-sme-5000w', name: '5GB (SME)', amount: 1840, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-sme-6000w', name: '6GB (SME)', amount: 2460, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-sme-1000', name: '1GB (SME)', amount: 770, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-sme-2000', name: '2GB (SME)', amount: 1430, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-sme-3000', name: '3GB (SME)', amount: 1770, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-sme-10000', name: '10GB (SME)', amount: 4470, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-40', name: '40MB (Gifting)', amount: 52, validity: '1 Day', network: 'mtn' },
  { id: 'mtn-gift-75', name: '75MB (Gifting)', amount: 76, validity: '1 Day', network: 'mtn' },
  { id: 'mtn-gift-500', name: '500MB (Gifting)', amount: 490, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-gift-750', name: '750MB (Gifting)', amount: 440, validity: '3 Days', network: 'mtn' },
  { id: 'mtn-gift-1000d', name: '1GB (Gifting)', amount: 490, validity: '1 Day', network: 'mtn' },
  { id: 'mtn-gift-2000d', name: '2GB (Gifting)', amount: 735, validity: '2 Days', network: 'mtn' },
  { id: 'mtn-gift-2501d', name: '2.5GB (Gifting)', amount: 735, validity: '1 Day', network: 'mtn' },
  { id: 'mtn-gift-2500d', name: '2.5GB (Gifting)', amount: 880, validity: '2 Days', network: 'mtn' },
  { id: 'mtn-gift-3200d', name: '3.2GB (Gifting)', amount: 980, validity: '2 Days', network: 'mtn' },
  { id: 'mtn-gift-1000w', name: '1GB (Gifting)', amount: 780, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-gift-1500w', name: '1.5GB (Gifting)', amount: 975, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-gift-6000w', name: '6GB (Gifting)', amount: 2415, validity: '7 Days', network: 'mtn' },
  { id: 'mtn-gift-2000', name: '2GB (Gifting)', amount: 1465, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-2700', name: '2.7GB (Gifting)', amount: 1950, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-3500', name: '3.5GB (Gifting)', amount: 2425, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-10000', name: '10GB (Gifting)', amount: 4375, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-12500', name: '12.5GB (Gifting)', amount: 5430, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-5000', name: '5GB (Gifting)', amount: 2580, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-7000', name: '7GB (Gifting)', amount: 3445, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-16500', name: '16.5GB (Gifting)', amount: 6355, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-20000', name: '20GB (Gifting)', amount: 7500, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-25000', name: '25GB (Gifting)', amount: 8900, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-36000', name: '36GB (Gifting)', amount: 10800, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-gift-75000', name: '75GB (Gifting)', amount: 17470, validity: '30 Days', network: 'mtn' },
  { id: 'mtn-awoof-1000d', name: '1GB (Awoof)', amount: 490, validity: '1 Day', network: 'mtn' },
  { id: 'mtn-awoof-1400w', name: '1.4GB (Awoof)', amount: 1756, validity: '3 Days', network: 'mtn' },
  { id: 'mtn-awoof-20000w', name: '20GB (Awoof)', amount: 9825, validity: '7 Days', network: 'mtn' },

  // Airtel
  { id: 'airtel-sme-150', name: '150MB (SME)', amount: 65, validity: '1 Day', network: 'airtel' },
  { id: 'airtel-sme-300', name: '300MB (SME)', amount: 114, validity: '2 Days', network: 'airtel' },
  { id: 'airtel-sme-600', name: '600MB (SME)', amount: 220, validity: '2 Days', network: 'airtel' },
  { id: 'airtel-sme-1000d', name: '1GB (SME)', amount: 358, validity: '1 Day', network: 'airtel' },
  { id: 'airtel-sme-3000w', name: '3GB (SME)', amount: 1070, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-sme-7000w', name: '7GB (SME)', amount: 2035, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-sme-4000', name: '4GB (SME)', amount: 2450, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-sme-10000', name: '10GB (SME)', amount: 3100, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-sme-13000', name: '13GB (SME)', amount: 4925, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-100', name: '100MB (Corporate)', amount: 105, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-corp-300', name: '300MB (Corporate)', amount: 270, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-corp-500', name: '500MB (Corporate)', amount: 490, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-1000', name: '1GB (Corporate)', amount: 980, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-2000', name: '2GB (Corporate)', amount: 1960, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-5000', name: '5GB (Corporate)', amount: 4900, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-10000', name: '10GB (Corporate)', amount: 9800, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-15000', name: '15GB (Corporate)', amount: 14700, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-corp-20000', name: '20GB (Corporate)', amount: 19600, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-75', name: '75MB (Gifting)', amount: 79.9, validity: '1 Day', network: 'airtel' },
  { id: 'airtel-gift-200', name: '200MB (Gifting)', amount: 206, validity: '3 Days', network: 'airtel' },
  { id: 'airtel-gift-500', name: '500MB (Gifting)', amount: 496, validity: '3 Days', network: 'airtel' },
  { id: 'airtel-gift-1000d', name: '1GB (Gifting)', amount: 495, validity: '1 Day', network: 'airtel' },
  { id: 'airtel-gift-1500d', name: '1.5GB (Gifting)', amount: 595, validity: '2 Days', network: 'airtel' },
  { id: 'airtel-gift-3000d', name: '3GB (Gifting)', amount: 990, validity: '2 Days', network: 'airtel' },
  { id: 'airtel-gift-1000w', name: '1GB (Gifting)', amount: 790, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-gift-1500w', name: '1.5GB (Gifting)', amount: 995, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-gift-6000w', name: '6GB (Gifting)', amount: 2493, validity: '7 Days', network: 'airtel' },
  { id: 'airtel-gift-2000', name: '2GB (Gifting)', amount: 1485, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-3000', name: '3GB (Gifting)', amount: 1980, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-4000', name: '4GB (Gifting)', amount: 2502, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-8000', name: '8GB (Gifting)', amount: 2993, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-10000', name: '10GB (Gifting)', amount: 3990, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-13000', name: '13GB (Gifting)', amount: 4973, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-18000', name: '18GB (Gifting)', amount: 6000, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-25000', name: '25GB (Gifting)', amount: 8055, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-35000', name: '35GB (Gifting)', amount: 10000, validity: '30 Days', network: 'airtel' },
  { id: 'airtel-gift-60000', name: '60GB (Gifting)', amount: 15275, validity: '30 Days', network: 'airtel' },

  // Glo
  { id: 'glo-sme-50', name: '50MB (SME)', amount: 52, validity: '1 Day', network: 'glo' },
  { id: 'glo-sme-125', name: '125MB (SME)', amount: 98, validity: '1 Day', network: 'glo' },
  { id: 'glo-sme-260', name: '260MB (SME)', amount: 192, validity: '2 Days', network: 'glo' },
  { id: 'glo-sme-350', name: '350MB (SME)', amount: 100, validity: '1 Day', network: 'glo' },
  { id: 'glo-sme-750n', name: '750MB (SME, Night)', amount: 119, validity: '1 Night', network: 'glo' },
  { id: 'glo-sme-750', name: '750MB (SME)', amount: 205, validity: '1 Day', network: 'glo' },
  { id: 'glo-sme-1250d', name: '1.25GB (SME, Sunday)', amount: 200, validity: '1 Sunday', network: 'glo' },
  { id: 'glo-sme-1500d', name: '1.5GB (SME)', amount: 300, validity: '1 Day', network: 'glo' },
  { id: 'glo-sme-2500d', name: '2.5GB (SME)', amount: 500, validity: '2 Days', network: 'glo' },
  { id: 'glo-sme-10000w', name: '10GB (SME)', amount: 2000, validity: '7 Days', network: 'glo' },
  { id: 'glo-corp-200', name: '200MB (Corporate)', amount: 90, validity: '14 Days', network: 'glo' },
  { id: 'glo-corp-500', name: '500MB (Corporate)', amount: 210, validity: '30 Days', network: 'glo' },
  { id: 'glo-corp-1000', name: '1GB (Corporate)', amount: 408, validity: '30 Days', network: 'glo' },
  { id: 'glo-corp-2000', name: '2GB (Corporate)', amount: 816, validity: '30 Days', network: 'glo' },
  { id: 'glo-corp-3000', name: '3GB (Corporate)', amount: 1225, validity: '30 Days', network: 'glo' },
  { id: 'glo-corp-5000', name: '5GB (Corporate)', amount: 2040, validity: '30 Days', network: 'glo' },
  { id: 'glo-corp-10000', name: '10GB (Corporate)', amount: 4050, validity: '30 Days', network: 'glo' },
  { id: 'glo-gift-50', name: '50MB (Gifting)', amount: 51, validity: '1 Day', network: 'glo' },
  { id: 'glo-gift-150', name: '150MB (Gifting)', amount: 97, validity: '1 Day', network: 'glo' },
  { id: 'glo-gift-350', name: '350MB (Gifting)', amount: 191, validity: '1 Day', network: 'glo' },
  { id: 'glo-gift-1000w', name: '1GB (Gifting)', amount: 470, validity: '14 Days', network: 'glo' },
  { id: 'glo-gift-3900', name: '3.9GB (Gifting)', amount: 945, validity: '30 Days', network: 'glo' },
  { id: 'glo-gift-7500', name: '7.5GB (Gifting)', amount: 2380, validity: '30 Days', network: 'glo' },
  { id: 'glo-gift-9000', name: '9.2GB (Gifting)', amount: 1905, validity: '30 Days', network: 'glo' },
  { id: 'glo-gift-10000', name: '10.8GB (Gifting)', amount: 2865, validity: '30 Days', network: 'glo' },
  { id: 'glo-gift-14000', name: '14GB (Gifting)', amount: 3830, validity: '30 Days', network: 'glo' },
  { id: 'glo-gift-18000', name: '18GB (Gifting)', amount: 4760, validity: '30 Days', network: 'glo' },

  // 9mobile
  { id: '9mobile-sme-250', name: '250MB (SME)', amount: 81, validity: '14 Days', network: '9mobile' },
  { id: '9mobile-sme-500', name: '500MB (SME)', amount: 135, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-sme-3500', name: '3.5GB (SME)', amount: 905, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-sme-7000', name: '7GB (SME)', amount: 1750, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-sme-15000', name: '15GB (SME)', amount: 3100, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-500', name: '500MB (Corporate)', amount: 147, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-1000', name: '1GB (Corporate)', amount: 285, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-1500', name: '1.5GB (Corporate)', amount: 435, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-2000', name: '2GB (Corporate)', amount: 570, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-3000', name: '3GB (Corporate)', amount: 855, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-4000', name: '4GB (Corporate)', amount: 1140, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-4500', name: '4.5GB (Corporate)', amount: 1283, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-5000', name: '5GB (Corporate)', amount: 1425, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-10000', name: '10GB (Corporate)', amount: 2850, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-11000', name: '11GB (Corporate)', amount: 4125, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-15000', name: '15GB (Corporate)', amount: 4275, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-20000', name: '20GB (Corporate)', amount: 5700, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-25000', name: '25GB (Corporate)', amount: 7125, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-30000', name: '30GB (Corporate)', amount: 8550, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-corp-40000', name: '40GB (Corporate)', amount: 11350, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-25', name: '25MB (Gifting)', amount: 87, validity: '1 Day', network: '9mobile' },
  { id: '9mobile-gift-2000d', name: '2GB (Gifting)', amount: 850, validity: '1 Day', network: '9mobile' },
  { id: '9mobile-gift-100', name: '100MB (Gifting)', amount: 187, validity: '7 Days', network: '9mobile' },
  { id: '9mobile-gift-250', name: '250MB (Gifting)', amount: 160, validity: '14 Days', network: '9mobile' },
  { id: '9mobile-gift-350', name: '350MB (Gifting)', amount: 594, validity: '7 Days', network: '9mobile' },
  { id: '9mobile-gift-1500w', name: '1.5GB (Gifting)', amount: 705, validity: '7 Days', network: '9mobile' },
  { id: '9mobile-gift-7000w', name: '7GB (Gifting)', amount: 2510, validity: '7 Days', network: '9mobile' },
  { id: '9mobile-gift-500', name: '500MB (Gifting)', amount: 320, validity: '14 Days', network: '9mobile' },
  { id: '9mobile-gift-5000w', name: '5GB (Gifting)', amount: 2350, validity: '14 Days', network: '9mobile' },
  { id: '9mobile-gift-1500', name: '1.5GB (Gifting)', amount: 1660, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-2000', name: '2GB (Gifting)', amount: 1984, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-3000', name: '3GB (Gifting)', amount: 2480, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-4500', name: '4.5GB (Gifting)', amount: 3320, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-5500', name: '5.5GB (Gifting)', amount: 6840, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-11000', name: '11GB (Gifting)', amount: 6630, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-15000', name: '15GB (Gifting)', amount: 8300, validity: '30 Days', network: '9mobile' },
  { id: '9mobile-gift-25000', name: '25GB (Gifting)', amount: 17820, validity: '30 Days', network: '9mobile' },
];

// Same 12 DISCO codes VTUAfrica's own pricing page confirms it supports
// (cross-checked live, 2026-07-03) — electricity now routes through
// VTUAfrica rather than VTU.ng.
const electricityProviders: ElectricityProvider[] = [
  { id: 'ikeja-electric', name: 'Ikeja Electric (IKEDC)', type: 'prepaid' },
  { id: 'eko-electric', name: 'Eko Electricity (EKEDC)', type: 'prepaid' },
  { id: 'ibadan-electric', name: 'Ibadan Electricity (IBEDC)', type: 'prepaid' },
  { id: 'portharcourt-electric', name: 'Port Harcourt (PHEDC)', type: 'prepaid' },
  { id: 'kaduna-electric', name: 'Kaduna Electricity (KEDC)', type: 'prepaid' },
  { id: 'kano-electric', name: 'Kano Electricity (KEDCO)', type: 'prepaid' },
  { id: 'jos-electric', name: 'Jos Electricity (JEDC)', type: 'prepaid' },
  { id: 'abuja-electric', name: 'Abuja Electricity (AEDC)', type: 'prepaid' },
  { id: 'enugu-electric', name: 'Enugu Electricity (EEDC)', type: 'prepaid' },
  { id: 'benin-electric', name: 'Benin Electricity (BEDC)', type: 'prepaid' },
  { id: 'aba-electric', name: 'Aba Electricity (ABEDC)', type: 'prepaid' },
  { id: 'yola-electric', name: 'Yola Electricity (YEDC)', type: 'prepaid' },
];

// Real, live catalog pulled directly from VTUAfrica's own "Subscription
// Plans and Prices" API page (confirmed live, 2026-07-03) — matches the
// server catalog in `_shared/vtu-catalog.ts` exactly (same ids). TV now
// routes through VTUAfrica rather than VTU.ng: no GOtv Supa/Supa Plus here,
// and Startimes is priced by tier + billing cadence (weekly/monthly)
// instead of Antenna/Dish, plus a "Smart" tier VTU.ng didn't have.
const tvProviders: TVProvider[] = [
  {
    id: 'dstv',
    name: 'DStv',
    bouquets: [
      { id: 'dstv-padi', name: 'Padi', amount: 4400 },
      { id: 'dstv-yanga', name: 'Yanga', amount: 6000 },
      { id: 'dstv-confam', name: 'Confam', amount: 11000 },
      { id: 'dstv-compact', name: 'Compact', amount: 19000 },
      { id: 'dstv-compact-plus', name: 'Compact Plus', amount: 30000 },
      { id: 'dstv-premium', name: 'Premium', amount: 44500 },
      { id: 'dstv-asia', name: 'Asia', amount: 14900 },
      { id: 'dstv-premium-french', name: 'Premium French', amount: 69000 },
    ],
  },
  {
    id: 'gotv',
    name: 'GOtv',
    bouquets: [
      { id: 'gotv-smallie', name: 'Smallie (1 Month)', amount: 1900 },
      { id: 'gotv-smallie-3months', name: 'Smallie (3 Months)', amount: 5100 },
      { id: 'gotv-smallie-1year', name: 'Smallie (1 Year)', amount: 15000 },
      { id: 'gotv-jinja', name: 'Jinja', amount: 3900 },
      { id: 'gotv-jolli', name: 'Jolli', amount: 5800 },
      { id: 'gotv-max', name: 'Max', amount: 8500 },
    ],
  },
  {
    id: 'startimes',
    name: 'Startimes',
    bouquets: [
      { id: 'startimes-nova-weekly', name: 'Nova (Weekly)', amount: 600 },
      { id: 'startimes-nova-monthly', name: 'Nova (Monthly)', amount: 1900 },
      { id: 'startimes-basic-weekly', name: 'Basic (Weekly)', amount: 1250 },
      { id: 'startimes-basic-monthly', name: 'Basic (Monthly)', amount: 3700 },
      { id: 'startimes-smart-weekly', name: 'Smart (Weekly)', amount: 1550 },
      { id: 'startimes-smart-monthly', name: 'Smart (Monthly)', amount: 4700 },
      { id: 'startimes-classic-weekly', name: 'Classic (Weekly)', amount: 1900 },
      { id: 'startimes-classic-monthly', name: 'Classic (Monthly)', amount: 5500 },
      { id: 'startimes-super-weekly', name: 'Super (Weekly)', amount: 3000 },
      { id: 'startimes-super-monthly', name: 'Super (Monthly)', amount: 9000 },
    ],
  },
];

// Routed to VTUAfrica's `/exam-pin` endpoint (VTU.ng never had a working
// exam pin integration). Ids match `_shared/vtu-catalog.ts`'s EXAM_PIN_TYPES
// exactly, confirmed live 2026-07-02. NECO GCE and NABTEB GCE are excluded —
// their listed prices (₦2 and ₦33) are clearly data errors on VTUAfrica's
// pricing page. JAMB PINs require a `profilecode` — the candidate's own
// JAMB profile code obtained directly from JAMB, not something we
// generate — and quantity is locked to 1 since one profile code can't cover
// multiple registration PINs in a single purchase.
const examTypes: ExamType[] = [
  { id: 'waec-result', name: 'WAEC Result Checking PIN', amount: 5000, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'waec-verification', name: 'WAEC Verification PIN', amount: 4000, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'waec-gce', name: 'WAEC GCE Registration PIN', amount: 24000, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'neco-result', name: 'NECO Result Checking Token', amount: 2100, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'nabteb-result', name: 'NABTEB Result Checking PIN', amount: 1200, quantity_options: [1, 2, 3, 4, 5] },
  { id: 'jamb-utme', name: 'JAMB UTME Registration PIN', amount: 7150, quantity_options: [1], requiresProfileCode: true },
  { id: 'jamb-direct-entry', name: 'JAMB Direct Entry Registration PIN', amount: 5650, quantity_options: [1], requiresProfileCode: true },
];

/**
 * Generate a client-side idempotency key so a double-tap / retry of the same
 * purchase maps to the same server transaction (the server enforces this).
 */
function newIdempotencyKey(): string {
  return `ksp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * All purchases go through the `vtu-purchase` Edge Function. The wallet debit,
 * provider call (with the secret API key) and refund-on-failure all happen
 * server-side — the client never moves money or holds provider credentials.
 */
async function purchase(
  body: Record<string, unknown>,
  authToken: string,
): Promise<VTUResult & { token?: string; pins?: string[]; units?: string }> {
  try {
    // Generated ONCE, before the call — invokeWithRetry uses this to check
    // whether an earlier attempt already succeeded server-side before ever
    // resubmitting (the PIN auth_token is single-use and gets consumed the
    // moment a request reaches the server, so blindly resubmitting on an
    // ambiguous network failure can hit "already used" even when the
    // original attempt actually went through — see network.ts).
    const idempotencyKey = newIdempotencyKey();
    const { data, error } = await invokeWithRetry<any>(
      () =>
        withTimeout(
          supabase.functions.invoke('vtu-purchase', {
            body: { ...body, auth_token: authToken, idempotency_key: idempotencyKey },
          }),
        ),
      idempotencyKey,
    );

    if (error) {
      // supabase.functions.invoke hides the Edge Function's own JSON error
      // body behind a generic message on any non-2xx — dig out the real one.
      let msg = 'Service temporarily unavailable. Please try again.';
      try {
        const errBody = await (error as any)?.context?.json?.();
        if (errBody?.error) msg = errBody.error;
      } catch {}
      return { success: false, error: msg };
    }
    if (!data?.success) {
      return { success: false, error: data?.error || 'Transaction failed' };
    }

    return {
      success: true,
      pending: data.pending,
      message: data.message,
      order_id: data.order_id,
      transaction_id: data.transaction_id,
      token: data.token,
      pins: data.pins,
      units: data.units,
    };
  } catch {
    return { success: false, error: 'Network error. Please try again.' };
  }
}

export const vtuService = {
  /**
   * Ask the server to verify a single pending order with VTUAfrica right now
   * and settle it if there's a final answer — so the result screen flips to
   * Successful/Failed the moment the provider confirms, instead of waiting for
   * the periodic reconcile sweep. Returns the order's status; falls back to
   * 'pending' on any error so the caller simply keeps polling.
   */
  async verifyOrder(transactionId: string): Promise<'completed' | 'failed' | 'pending'> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('vtu-verify-order', { body: { transaction_id: transactionId } }),
      );
      if (error || !data?.status) return 'pending';
      return data.status === 'completed' || data.status === 'failed' ? data.status : 'pending';
    } catch {
      return 'pending';
    }
  },

  getDataBundles(network: NetworkProvider): DataBundle[] {
    return dataBundles.filter((b) => b.network === network);
  },

  getAirtimeAmounts(): number[] {
    return airtimeAmounts;
  },

  getElectricityProviders(): ElectricityProvider[] {
    return electricityProviders;
  },

  /** Maps a biller id (stored in a transaction's metadata) back to its display name. */
  getElectricityProviderName(billerId: string): string {
    return electricityProviders.find((p) => p.id === billerId)?.name || billerId;
  },

  getTVProviders(): TVProvider[] {
    return tvProviders;
  },

  getExamTypes(): ExamType[] {
    return examTypes;
  },

  buyAirtime(phone: string, network: NetworkProvider, amount: number, authToken: string): Promise<VTUResult> {
    // amount is naira from the UI; the server ledger works in kobo.
    return purchase({ service: 'airtime', phone, network, amount: nairaToKobo(amount) }, authToken);
  },

  buyData(phone: string, network: NetworkProvider, bundle: DataBundle, authToken: string): Promise<VTUResult> {
    return purchase({ service: 'data', phone, network, bundle_id: bundle.id }, authToken);
  },

  /**
   * Sends airtime to several recipients one at a time (not in parallel, so
   * wallet debits stay ordered and we don't hammer the provider). Each call
   * reuses buyAirtime, so every recipient still gets its own idempotency key
   * via the existing vtu-purchase Edge Function — no server changes needed.
   * `authToken` must have been minted with maxUses >= recipients.length
   * (see TransactionAuthProvider's `maxUses` option) since one PIN entry
   * authorizes the whole batch.
   */
  async buyAirtimeBatch(
    recipients: BatchAirtimeRecipient[],
    authToken: string,
    onProgress?: (index: number, result: BatchResultItem) => void,
  ): Promise<BatchResultItem[]> {
    const results: BatchResultItem[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const res = await vtuService.buyAirtime(r.phone, r.network, r.amount, authToken);
      const item: BatchResultItem = {
        phone: r.phone,
        success: res.success,
        pending: res.pending,
        transaction_id: res.transaction_id,
        order_id: res.order_id,
        error: res.error,
      };
      results.push(item);
      onProgress?.(i, item);
    }
    return results;
  },

  async buyDataBatch(
    recipients: BatchDataRecipient[],
    authToken: string,
    onProgress?: (index: number, result: BatchResultItem) => void,
  ): Promise<BatchResultItem[]> {
    const results: BatchResultItem[] = [];
    for (let i = 0; i < recipients.length; i++) {
      const r = recipients[i];
      const res = await vtuService.buyData(r.phone, r.network, r.bundle, authToken);
      const item: BatchResultItem = {
        phone: r.phone,
        success: res.success,
        pending: res.pending,
        transaction_id: res.transaction_id,
        order_id: res.order_id,
        error: res.error,
      };
      results.push(item);
      onProgress?.(i, item);
    }
    return results;
  },

  buyElectricity(
    providerId: string,
    meterNumber: string,
    amount: number,
    type: 'prepaid' | 'postpaid',
    authToken: string,
  ): Promise<VTUResult & { token?: string; units?: string }> {
    return purchase({
      service: 'electricity',
      provider_id: providerId,
      meter_number: meterNumber,
      amount: nairaToKobo(amount),
      type,
    }, authToken);
  },

  buyTVSubscription(
    providerId: string,
    smartcardNumber: string,
    bouquetId: string,
    _amount: number,
    authToken: string,
  ): Promise<VTUResult> {
    // Price is resolved server-side from bouquetId; client amount is ignored.
    return purchase({
      service: 'tv',
      provider_id: providerId,
      smartcard_number: smartcardNumber,
      bouquet_id: bouquetId,
    }, authToken);
  },

  buyExamPin(
    examType: ExamType,
    quantity: number,
    authToken: string,
    profileCode?: string,
  ): Promise<VTUResult & { pins?: string[] }> {
    return purchase({
      service: 'exam_pin',
      exam_id: examType.id,
      quantity,
      ...(profileCode ? { profile_code: profileCode } : {}),
    }, authToken);
  },
};
