/**
 * All money is handled as integer minor units (kobo, cents, pesewas…) to avoid
 * floating point drift. Convert at the edges only.
 */
export type MinorUnits = number;

/** ISO-4217 currencies we currently trade in, with their minor-unit exponent. */
export const CURRENCY_EXPONENT: Record<string, number> = {
  NGN: 2,
  GHS: 2,
  KES: 2,
  ZAR: 2,
  USD: 2,
  GBP: 2,
  EUR: 2,
  UGX: 0,
  RWF: 0,
};

export function exponentFor(currency: string): number {
  const exp = CURRENCY_EXPONENT[currency.toUpperCase()];
  if (exp === undefined) throw new Error(`Unsupported currency: ${currency}`);
  return exp;
}

export function toMajor(amount: MinorUnits, currency: string): number {
  return amount / 10 ** exponentFor(currency);
}

export function toMinor(amount: number, currency: string): MinorUnits {
  return Math.round(amount * 10 ** exponentFor(currency));
}

export interface FeeSplit {
  gross: MinorUnits;
  platformFee: MinorUnits;
  payeeAmount: MinorUnits;
}

/**
 * Platform commission: `bps` basis points of the gross, clamped to [min, max]
 * (a max of 0 means uncapped) and never more than the gross itself.
 */
export function splitFee(gross: MinorUnits, opts: { bps: number; min?: MinorUnits; max?: MinorUnits }): FeeSplit {
  if (!Number.isInteger(gross) || gross <= 0) throw new Error('gross must be a positive integer (minor units)');
  let fee = Math.round((gross * opts.bps) / 10_000);
  if (opts.min) fee = Math.max(fee, opts.min);
  if (opts.max) fee = Math.min(fee, opts.max);
  fee = Math.min(fee, gross);
  return { gross, platformFee: fee, payeeAmount: gross - fee };
}
