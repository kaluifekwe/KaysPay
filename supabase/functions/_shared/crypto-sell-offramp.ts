// Shared by crypto-sell (direct USDT sale) and crypto-quidax-webhook (the
// coin-via-swap sale's second leg, once the swap has landed as USDT) --
// both need to run the EXACT same off-ramp initiation, so this exists once
// rather than twice risking drift. See migration 211 for why the webhook
// needs this at all.
//
// Split into two steps, not one, so callers can record the pending sale
// with Quidax's OWN returned reference (needed for the completion webhook
// to ever match it -- Quidax's docs are inconsistent about which of
// reference/merchant_reference their webhook actually keys on, so both are
// stored) in between: open the sale (which is what actually returns that
// reference) and only THEN execute the withdrawal, the genuinely
// irreversible step. Calling both back to back without recording in
// between would leave a real Quidax sale/withdrawal running with no local
// record of it at all if the process died between the two calls.
import { createWithdrawal } from "./quidax-client.ts";
import {
  attachOffRampBankAccount,
  confirmOffRamp,
  initiateOffRamp,
  OffRampNameMismatchError,
} from "./quidax-ramp-client.ts";

// Same network used throughout Buy/Withdraw for USDT -- see EXTERNAL_NETWORK_MAP.
export const OFFRAMP_USDT_NETWORK = "bep20";

export interface OpenOffRampResult {
  success: boolean;
  reference?: string;
  depositAddress?: string;
  depositNetwork?: string;
  error?: string;
  nameMismatch?: boolean;
}

/** initiateOffRamp -> attachOffRampBankAccount -> confirmOffRamp. Returns
 * Quidax's own reference and the deposit address the USDT must be
 * withdrawn to -- nothing irreversible has happened yet at this point. */
export async function openUsdtOffRampSale(params: {
  merchantReference: string;
  cryptoAmount: number;
  email: string;
  firstName: string;
  lastName: string;
  bankCode: string;
  accountNumber: string;
}): Promise<OpenOffRampResult> {
  const initiated = await initiateOffRamp({
    merchantReference: params.merchantReference,
    cryptoAmount: params.cryptoAmount,
    asset: "USDT",
    network: OFFRAMP_USDT_NETWORK,
    email: params.email,
    firstName: params.firstName,
    lastName: params.lastName,
  });

  try {
    await attachOffRampBankAccount({
      merchantReference: params.merchantReference,
      bankCode: params.bankCode,
      accountNumber: params.accountNumber,
    });
  } catch (e) {
    if (e instanceof OffRampNameMismatchError) {
      return { success: false, error: "This account's registered name doesn't match your KaysPay profile. Please use an account in your own name.", nameMismatch: true };
    }
    throw e;
  }

  const deposit = await confirmOffRamp(params.merchantReference);
  if (!deposit.address) {
    return { success: false, error: "Could not prepare this sale. Please try again." };
  }

  return {
    success: true,
    reference: initiated.reference,
    depositAddress: deposit.address,
    depositNetwork: deposit.network || OFFRAMP_USDT_NETWORK,
  };
}

/** The actual on-chain withdrawal to Quidax's off-ramp deposit address --
 * irreversible from here. Caller must have already recorded a pending sale
 * referencing this merchantReference before calling this. */
export async function executeUsdtOffRampWithdrawal(params: {
  quidaxUserId: string;
  cryptoAmount: number;
  merchantReference: string;
  depositAddress: string;
  depositNetwork: string;
}): Promise<void> {
  await createWithdrawal({
    quidaxUserId: params.quidaxUserId,
    currency: "usdt",
    amount: String(params.cryptoAmount),
    fundUid: params.depositAddress,
    network: params.depositNetwork,
    reference: params.merchantReference,
  });
}
