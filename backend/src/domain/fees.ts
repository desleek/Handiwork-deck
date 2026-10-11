/**
 * Gateway fee schedules and wallet-bonus economics (Section 15).
 *
 * The spec requires bonus percentages to be "funded by genuine processing savings". The saving
 * comes from fee caps: a customer who tops up ₦200,000 once pays one capped gateway fee, then pays
 * several jobs from the wallet with no gateway fee at all. Paying those same jobs by card would
 * incur a fee on every job. The difference is what the platform can afford to give back as a bonus.
 *
 * All amounts are minor units (kobo); percentages are basis points.
 */
import { applyBps } from './pricing.ts';

export interface FeeSchedule {
  /** Percentage on local card / transfer / USSD collections. */
  localBps: number;
  /** Flat fee added per collection. */
  flatMinor: number;
  /** Flat fee waived for collections strictly below this amount. */
  flatWaivedBelowMinor: number;
  /** Maximum fee per local collection. */
  capMinor: number;
  /** Dedicated virtual account (pay-by-transfer) collections, if priced differently. */
  virtualAccount?: { bps: number; capMinor: number };
  /** Payout (transfer) fee bands: first band whose maxMinor >= amount applies. */
  transferBands: { maxMinor: number | null; feeMinor: number }[];
}

const N = 100;

/**
 * Defaults from the providers' published Nigerian pricing as checked in October 2026.
 * Admin-editable (setting `gatewayFeeSchedules`) — confirm against your signed rate card.
 */
export const DEFAULT_FEE_SCHEDULES: Record<string, FeeSchedule> = {
  paystack: {
    localBps: 150,
    flatMinor: 100 * N,
    flatWaivedBelowMinor: 2_500 * N,
    capMinor: 2_000 * N,
    virtualAccount: { bps: 100, capMinor: 300 * N },
    transferBands: [
      { maxMinor: 5_000 * N, feeMinor: 10 * N },
      { maxMinor: 50_000 * N, feeMinor: 25 * N },
      { maxMinor: null, feeMinor: 50 * N },
    ],
  },
  flutterwave: {
    localBps: 140,
    flatMinor: 0,
    flatWaivedBelowMinor: 0,
    capMinor: 2_000 * N,
    transferBands: [
      { maxMinor: 5_000 * N, feeMinor: 10 * N },
      { maxMinor: 50_000 * N, feeMinor: 25 * N },
      { maxMinor: null, feeMinor: 50 * N },
    ],
  },
};

export type CollectionChannel = 'card' | 'bank_transfer' | 'ussd' | 'virtual_account';

/** What the gateway charges the platform to collect `amountMinor`. */
export function collectionFee(amountMinor: number, s: FeeSchedule, channel: CollectionChannel = 'card'): number {
  if (amountMinor <= 0) return 0;
  if (channel === 'virtual_account' && s.virtualAccount) {
    return Math.min(s.virtualAccount.capMinor, applyBps(amountMinor, s.virtualAccount.bps));
  }
  const flat = amountMinor < s.flatWaivedBelowMinor ? 0 : s.flatMinor;
  return Math.min(s.capMinor, applyBps(amountMinor, s.localBps) + flat);
}

/** What the gateway charges the platform to pay out `amountMinor` to a bank account. */
export function transferFee(amountMinor: number, s: FeeSchedule): number {
  const band = s.transferBands.find((b) => b.maxMinor === null || amountMinor <= b.maxMinor);
  return band?.feeMinor ?? 0;
}

export interface BonusEconomicsRow {
  topupMinor: number;
  bonusBps: number;
  bonusMinor: number;
  /** Fee the platform pays to collect the top-up. */
  topupFeeMinor: number;
  /** Number of average-size jobs the top-up pays for (may be fractional). */
  jobsFunded: number;
  /** Fees the platform would have paid collecting those jobs one by one. */
  avoidedJobFeesMinor: number;
  /** avoided − top-up fee − bonus. Positive means the bonus is funded by real savings. */
  marginMinor: number;
  funded: boolean;
}

/**
 * Margin of a single top-up at a given bonus rate, assuming the wallet balance is spent on jobs of
 * `avgJobMinor` each that would otherwise have been paid by card through the same gateway.
 */
export function bonusEconomics(p: {
  topupMinor: number;
  bonusBps: number;
  avgJobMinor: number;
  schedule: FeeSchedule;
  topupChannel?: CollectionChannel;
}): BonusEconomicsRow {
  const bonusMinor = applyBps(p.topupMinor, p.bonusBps);
  const topupFeeMinor = collectionFee(p.topupMinor, p.schedule, p.topupChannel ?? 'card');
  const spendable = p.topupMinor + bonusMinor;
  const jobsFunded = spendable / p.avgJobMinor;
  const whole = Math.floor(jobsFunded);
  const remainder = spendable - whole * p.avgJobMinor;
  const avoidedJobFeesMinor = whole * collectionFee(p.avgJobMinor, p.schedule) + collectionFee(remainder, p.schedule);
  const marginMinor = avoidedJobFeesMinor - topupFeeMinor - bonusMinor;
  return {
    topupMinor: p.topupMinor,
    bonusBps: p.bonusBps,
    bonusMinor,
    topupFeeMinor,
    jobsFunded: Math.round(jobsFunded * 100) / 100,
    avoidedJobFeesMinor,
    marginMinor,
    funded: marginMinor >= 0,
  };
}

/**
 * The highest bonus (bps) a top-up of this size can afford while still breaking even.
 * Useful when tuning tiers in the admin panel.
 */
export function breakEvenBonusBps(p: { topupMinor: number; avgJobMinor: number; schedule: FeeSchedule; topupChannel?: CollectionChannel }): number {
  let lo = 0;
  let hi = 10_000;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bonusEconomics({ ...p, bonusBps: mid }).funded) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Instant-withdrawal fee margin: what the user pays minus what the transfer costs the platform. */
export function withdrawalMargin(amountMinor: number, userFeeMinor: number, s: FeeSchedule) {
  const cost = transferFee(amountMinor - userFeeMinor, s);
  return { userFeeMinor, providerCostMinor: cost, marginMinor: userFeeMinor - cost };
}
