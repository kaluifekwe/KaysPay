// App-wide theme tokens. Light mirrors the original static Colors palette
// (constants/colors.ts) so light-mode users see zero change; Dark reuses the
// exact palette CryptoScreen.tsx originally built for itself, now promoted
// here so the whole app can share one consistent dark look via the Settings
// toggle instead of Crypto being permanently dark on its own.
import { Colors } from './colors';

export interface AppTheme {
  mode: 'light' | 'dark';
  // Surfaces
  background: string;
  surface: string;
  surfaceRaised: string;
  surfaceRaised2: string;
  hairline: string;
  hairlineSoft: string;
  border: string;
  // Text
  ink: string;
  inkMuted: string;
  inkFaint: string;
  // Brand
  brand: string;
  brandDark: string;
  brandSoft: string;
  // Secondary accent
  gold: string;
  goldSoft: string;
  // Semantic
  up: string;
  down: string;
  errorBg: string;
  // Text that sits on a filled brand-colored button/badge
  onBrand: string;
  // expo-status-bar style + the color behind it
  statusBarStyle: 'light' | 'dark';
  statusBarBg: string;
}

export const LightTheme: AppTheme = {
  mode: 'light',
  background: Colors.WHITE,
  surface: Colors.WHITE,
  surfaceRaised: Colors.LIGHT_GRAY,
  surfaceRaised2: Colors.GREEN_10,
  hairline: Colors.BORDER,
  hairlineSoft: Colors.BORDER,
  border: Colors.BORDER,
  ink: Colors.DARK,
  inkMuted: Colors.GRAY,
  inkFaint: Colors.GRAY,
  brand: Colors.GREEN,
  brandDark: Colors.GREEN_DARK,
  brandSoft: Colors.GREEN_10,
  gold: Colors.AMBER,
  goldSoft: '#FDF1DC',
  up: Colors.GREEN,
  down: Colors.RED,
  errorBg: '#FCEBEB',
  onBrand: Colors.WHITE,
  statusBarStyle: 'light',
  statusBarBg: Colors.GREEN_DARK,
};

export const DarkTheme: AppTheme = {
  mode: 'dark',
  background: '#0A100C',
  surface: '#121912',
  surfaceRaised: '#1B241C',
  surfaceRaised2: '#212C22',
  hairline: '#28352C',
  hairlineSoft: '#1E2921',
  border: '#28352C',
  ink: '#EFF5F0',
  inkMuted: '#8FA294',
  inkFaint: '#5C6E62',
  brand: '#35B073',
  brandDark: '#1E4A31',
  brandSoft: '#1E4A31',
  gold: '#E7B451',
  goldSoft: '#4A3A1C',
  up: '#5FD98A',
  down: '#F16A5C',
  errorBg: '#3A1F1C',
  onBrand: '#0A100C',
  statusBarStyle: 'light',
  statusBarBg: '#0A100C',
};

export const THEMES: Record<'light' | 'dark', AppTheme> = {
  light: LightTheme,
  dark: DarkTheme,
};
