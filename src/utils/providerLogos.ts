import { ImageSourcePropType } from 'react-native';
import { NgNetwork } from './phone';

export const NETWORK_LOGOS: Record<NgNetwork, ImageSourcePropType> = {
  mtn: require('../../assets/logos/mtn.png'),
  airtel: require('../../assets/logos/airtel.png'),
  glo: require('../../assets/logos/glo.png'),
  '9mobile': require('../../assets/logos/9mobile.png'),
};

export const TV_LOGOS: Record<string, ImageSourcePropType> = {
  dstv: require('../../assets/logos/dstv.png'),
  gotv: require('../../assets/logos/gotv.png'),
  startimes: require('../../assets/logos/startimes.png'),
};

export const EXAM_LOGOS: Partial<Record<string, ImageSourcePropType>> = {
  waec: require('../../assets/logos/waec.png'),
  neco: require('../../assets/logos/neco.png'),
  nabteb: require('../../assets/logos/nabteb.png'),
  jamb: require('../../assets/logos/jamb.png'),
};

// Enugu (EEDC), Kano (KEDCO), Yola (YEDC), and Aba (ABEDC) have no usable
// clean logo image available — those fall back to an initials badge instead.
export const ELECTRICITY_LOGOS: Partial<Record<string, ImageSourcePropType>> = {
  'ikeja-electric': require('../../assets/logos/ikeja-electric.png'),
  'eko-electric': require('../../assets/logos/eko-electric.png'),
  'ibadan-electric': require('../../assets/logos/ibadan-electric.png'),
  'kaduna-electric': require('../../assets/logos/kaduna-electric.png'),
  'jos-electric': require('../../assets/logos/jos-electric.png'),
  'benin-electric': require('../../assets/logos/benin-electric.png'),
  'abuja-electric': require('../../assets/logos/abuja-electric.png'),
  'portharcourt-electric': require('../../assets/logos/portharcourt-electric.png'),
};

// BetBiga, Paripesa, and Naira Million have no usable clean logo available
// (BetBiga/Paripesa: official sites block scraping, no entry on the usual
// logo-aggregator sites; Naira Million: only found a white-on-transparent
// mark that's invisible against the app's white cards) — those three fall
// back to an initials badge. MerryBet/NaijaBet/BangBet/LiveScoreBet are
// site-favicon-derived (small but legitimate square icons) since no
// dedicated logo asset existed for them either.
export const BETTING_LOGOS: Partial<Record<string, ImageSourcePropType>> = {
  bet9ja: require('../../assets/logos/bet9ja.png'),
  betking: require('../../assets/logos/betking.png'),
  '1xbet': require('../../assets/logos/1xbet.png'),
  nairabet: require('../../assets/logos/nairabet.png'),
  merrybet: require('../../assets/logos/merrybet.png'),
  sportybet: require('../../assets/logos/sportybet.png'),
  naijabet: require('../../assets/logos/naijabet.png'),
  betway: require('../../assets/logos/betway.png'),
  bangbet: require('../../assets/logos/bangbet.png'),
  melbet: require('../../assets/logos/melbet.png'),
  livescorebet: require('../../assets/logos/livescorebet.png'),
  cloudbet: require('../../assets/logos/cloudbet.png'),
  mylottohub: require('../../assets/logos/mylottohub.png'),
};
