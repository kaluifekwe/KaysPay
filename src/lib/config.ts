export const Config = {
  TEST_MODE: process.env.EXPO_PUBLIC_TEST_MODE === 'true',
  SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY!,
} as const;
