/**
 * Wallet top-up bonus and withdrawal fees (Section 15).
 */
import type { WalletBonusTier } from './settings.ts';
import { applyBps } from './pricing.ts';

export function bonusWindowEnd(accountCreatedAt: Date, windowDays: number, extendedUntil: Date | null): Date {
  const base = new Date(accountCreatedAt.getTime() + windowDays * 86_400_000);
  return extendedUntil && extendedUntil > base ? extendedUntil : base;
}

export function topupBonus(params: {
  amountMinor: number;
  now: Date;
  windowEnd: Date;
  tiers: WalletBonusTier[];
  enabled: boolean;
}): { bonusMinor: number; bonusBps: number } {
  if (!params.enabled || params.now > params.windowEnd) return { bonusMinor: 0, bonusBps: 0 };
  const tier = params.tiers.find(
    (t) => params.amountMinor >= t.minTopupMinor && (t.maxTopupMinor === null || params.amountMinor < t.maxTopupMinor),
  );
  const bps = tier?.bonusBps ?? 0;
  return { bonusMinor: applyBps(params.amountMinor, bps), bonusBps: bps };
}

export function withdrawalFee(
  amountMinor: number,
  speed: 'standard' | 'instant',
  cfg: { standardFeeMinor: number; instantFeeBps: number; instantMinMinor: number; instantMaxMinor: number },
): number {
  if (speed === 'standard') return cfg.standardFeeMinor;
  const fee = applyBps(amountMinor, cfg.instantFeeBps);
  return Math.min(cfg.instantMaxMinor, Math.max(cfg.instantMinMinor, fee));
}

/**
 * Quote shown before the user confirms: the fee is deducted from the withdrawn amount,
 * so the user sees exactly what lands in their bank account.
 */
export function withdrawalQuote(
  amountMinor: number,
  balanceMinor: number,
  speed: 'standard' | 'instant',
  cfg: Parameters<typeof withdrawalFee>[2],
) {
  const feeMinor = withdrawalFee(amountMinor, speed, cfg);
  return {
    amountMinor,
    feeMinor,
    receiveMinor: amountMinor - feeMinor,
    ok: amountMinor <= balanceMinor && amountMinor > feeMinor,
  };
}
