import { Colors } from '../constants/colors';

const MTN = ['0703', '0706', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916'];
const AIRTEL = ['0701', '0708', '0802', '0808', '0812', '0902', '0907', '0912'];
const GLO = ['0705', '0805', '0807', '0811', '0815', '0905', '0915'];
const MOBILE = ['0809', '0817', '0818', '0908', '0909'];

export interface NetworkInfo {
  network: string;
  color: string;
  logo: string;
}

export function detectNetwork(phone: string): NetworkInfo {
  // Remove non-digits and get last 11 digits
  const digits = phone.replace(/\D/g, '').slice(-11);

  if (digits.length < 4) {
    return { network: 'Unknown', color: Colors.GRAY, logo: 'unknown' };
  }

  const prefix = digits.slice(0, 4);

  if (MTN.includes(prefix)) {
    return { network: 'MTN', color: Colors.MTN, logo: 'mtn' };
  }
  if (AIRTEL.includes(prefix)) {
    return { network: 'Airtel', color: Colors.AIRTEL, logo: 'airtel' };
  }
  if (GLO.includes(prefix)) {
    return { network: 'Glo', color: Colors.GLO, logo: 'glo' };
  }
  if (MOBILE.includes(prefix)) {
    return { network: '9mobile', color: Colors.MOBILE, logo: '9mobile' };
  }

  return { network: 'Unknown', color: Colors.GRAY, logo: 'unknown' };
}

export function formatNigerianPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');

  if (digits.length <= 4) return digits;
  if (digits.length <= 7) return `${digits.slice(0, 4)} ${digits.slice(4)}`;
  return `${digits.slice(0, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
}

export function validateNigerianPhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');

  // Must be 11 digits starting with 0
  if (digits.length !== 11) return false;
  if (!digits.startsWith('0')) return false;

  // Check if prefix is valid
  const prefix = digits.slice(0, 4);
  const allPrefixes = [...MTN, ...AIRTEL, ...GLO, ...MOBILE];
  return allPrefixes.includes(prefix);
}
