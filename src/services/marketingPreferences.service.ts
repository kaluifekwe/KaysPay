import { supabase } from '../lib/supabase';
import { withTimeout } from '../utils/network';

export const marketingPreferencesService = {
  async getEmailOptIn(): Promise<boolean> {
    const { data, error } = await withTimeout(
      (async () => await supabase.rpc('get_my_email_marketing_consent'))(),
      10_000,
    );
    if (error) throw new Error('Could not load email preferences');
    return data === true;
  },

  async setEmailOptIn(optIn: boolean, source: 'registration' | 'settings' = 'settings'): Promise<void> {
    const { error } = await withTimeout(
      (async () => await supabase.rpc('set_my_email_marketing_consent', { p_opt_in: optIn, p_source: source }))(),
      10_000,
    );
    if (error) throw new Error('Could not update email preferences');
  },
};
