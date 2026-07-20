import { supabase } from '../lib/supabase';
import { withTimeout, invokeWithRetry } from '../utils/network';

export type PayrollFrequency = 'once' | 'weekly' | 'monthly';

export interface PayrollScheduleRecipient {
  phone: string;        // digits only, 0XXXXXXXXXX
  network: string;      // mtn | airtel | glo | 9mobile
  amount_kobo?: number; // airtime
  bundle_id?: string;   // data
}

export interface ScheduleResult {
  success: boolean;
  payroll_id?: string;
  scheduled_for?: string;
  error?: string;
}

export interface ScheduledPayroll {
  id: string;
  service_type: 'airtime' | 'data';
  recipients: any[];
  total_amount: number; // kobo
  frequency: PayrollFrequency;
  next_run: string;
  status: string;
  run_count: number;
}

function newIdempotencyKey(): string {
  return `ksp_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export const payrollService = {
  /**
   * Creates a payroll mandate. For a recurring frequency the wallet is charged
   * at EACH run (not now); the PIN authorizes the recurring mandate.
   */
  async schedule(
    serviceType: 'airtime' | 'data',
    recipients: PayrollScheduleRecipient[],
    scheduledForISO: string,
    frequency: PayrollFrequency,
    authToken: string,
  ): Promise<ScheduleResult> {
    try {
      const idempotencyKey = newIdempotencyKey();
      const { data, error } = await invokeWithRetry<any>(
        () =>
          withTimeout(
            supabase.functions.invoke('payroll-schedule', {
              body: {
                service_type: serviceType,
                recipients,
                scheduled_for: scheduledForISO,
                frequency,
                auth_token: authToken,
                idempotency_key: idempotencyKey,
              },
            }),
          ),
        idempotencyKey,
        {
          table: 'scheduled_payrolls',
          keyColumn: 'idempotency_key',
          existsOnly: true, // creating the mandate IS the whole action — no separate completed/pending state
          buildRecovered: (_outcome, row) => ({
            success: true,
            payroll_id: row?.id,
            scheduled_for: row?.scheduled_for,
          }),
        },
      );
      if (error) {
        let msg = 'Could not schedule payroll. Please try again.';
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) msg = body.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Could not schedule payroll' };
      return { success: true, payroll_id: data.payroll_id, scheduled_for: data.scheduled_for };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /** Lists the user's active (recurring or upcoming) payrolls. */
  async getActive(): Promise<ScheduledPayroll[]> {
    try {
      const { data } = await supabase
        .from('scheduled_payrolls')
        .select('id, service_type, recipients, total_amount, frequency, next_run, status, run_count')
        .eq('active', true)
        .order('next_run', { ascending: true });
      return (data as ScheduledPayroll[]) || [];
    } catch {
      return [];
    }
  },

  /** Replaces an active payroll's recipient list (PIN-authorized). */
  async update(
    payrollId: string,
    recipients: PayrollScheduleRecipient[],
    authToken: string,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('payroll-update', {
          body: { payroll_id: payrollId, recipients, auth_token: authToken },
        }),
      );
      if (error) {
        let msg = 'Could not update payroll. Please try again.';
        try {
          const body = await (error as any)?.context?.json?.();
          if (body?.error) msg = body.error;
        } catch {}
        return { success: false, error: msg };
      }
      if (!data?.success) return { success: false, error: data?.error || 'Could not update payroll' };
      return { success: true };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },

  /** Cancels a payroll so it stops running. */
  async cancel(payrollId: string): Promise<{ success: boolean; error?: string }> {
    try {
      const { data, error } = await withTimeout(
        supabase.functions.invoke('payroll-cancel', { body: { payroll_id: payrollId } }),
      );
      if (error) return { success: false, error: 'Could not cancel. Please try again.' };
      if (!data?.success) return { success: false, error: data?.error || 'Could not cancel' };
      return { success: true };
    } catch {
      return { success: false, error: 'Network error. Please try again.' };
    }
  },
};
