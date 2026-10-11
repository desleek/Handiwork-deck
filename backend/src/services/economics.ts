import { one } from '../db/pool.ts';
import { bonusEconomics, breakEvenBonusBps, collectionFee, withdrawalMargin, type CollectionChannel, type FeeSchedule } from '../domain/fees.ts';
import type { PlatformSettings, WalletBonusTier } from '../domain/settings.ts';
import { withdrawalFee } from '../domain/wallet.ts';

const MIN_SAMPLE = 20;

/** Real average job value (last 90 days) once there's enough data; otherwise the configured fallback. */
export async function averageJobValue(s: PlatformSettings) {
  const r = await one<{ n: number; avg: number | null }>(
    `SELECT count(*)::int AS n, avg(amount_minor)::float8 AS avg FROM payments
      WHERE purpose = 'job' AND status = 'captured' AND created_at > now() - interval '90 days'`,
  );
  if (r && r.n >= MIN_SAMPLE && r.avg) return { avgJobMinor: Math.round(r.avg), source: 'actual' as const, sample: r.n };
  return { avgJobMinor: s.economicsAvgJobMinor, source: 'setting' as const, sample: r?.n ?? 0 };
}

function samplePoints(t: WalletBonusTier): number[] {
  if (t.maxTopupMinor === null) return [t.minTopupMinor, t.minTopupMinor * 2, t.minTopupMinor * 4];
  const max = t.maxTopupMinor - 1;
  return [t.minTopupMinor, Math.round((t.minTopupMinor + max) / 2), max];
}

export function tierEconomics(tiers: WalletBonusTier[], schedule: FeeSchedule, avgJobMinor: number, channel: CollectionChannel) {
  return tiers
    .filter((t) => t.bonusBps > 0)
    .flatMap((t) =>
      samplePoints(t).map((amt) => ({
        ...bonusEconomics({ topupMinor: amt, bonusBps: t.bonusBps, avgJobMinor, schedule, topupChannel: channel }),
        breakEvenBps: breakEvenBonusBps({ topupMinor: amt, avgJobMinor, schedule, topupChannel: channel }),
      })),
    );
}

/** Warnings shown when an admin saves bonus tiers that would cost more than the fees they save. */
export function unfundedWarnings(tiers: WalletBonusTier[], s: PlatformSettings, avgJobMinor: number): string[] {
  const warnings: string[] = [];
  for (const provider of s.gatewayPriority.filter((p) => s.gatewayFeeSchedules[p])) {
    for (const row of tierEconomics(tiers, s.gatewayFeeSchedules[provider], avgJobMinor, 'card')) {
      if (!row.funded) {
        warnings.push(
          `${provider}: a ₦${(row.topupMinor / 100).toLocaleString('en-NG')} card top-up at ${row.bonusBps / 100}% loses ₦${(-row.marginMinor / 100).toFixed(2)} (break-even ${row.breakEvenBps / 100}%).`,
        );
      }
    }
  }
  return warnings;
}

/** Full report for the admin panel (Section 15): modelled tiers + realised figures + withdrawal margins. */
export async function bonusEconomicsReport(s: PlatformSettings, opts: { provider?: string; avgJobMinor?: number; channel?: CollectionChannel }) {
  const provider = opts.provider ?? s.gatewayPriority.find((p) => s.gatewayFeeSchedules[p]) ?? 'paystack';
  const schedule = s.gatewayFeeSchedules[provider];
  if (!schedule) throw new Error(`No fee schedule for ${provider}`);
  const avg = opts.avgJobMinor ? { avgJobMinor: opts.avgJobMinor, source: 'override' as const, sample: 0 } : await averageJobValue(s);
  const channel = opts.channel ?? 'card';

  const realised = await one<any>(
    `SELECT
       COALESCE(sum(amount_minor) FILTER (WHERE purpose = 'wallet_topup'), 0)::bigint AS topups_minor,
       count(*) FILTER (WHERE purpose = 'wallet_topup')::int AS topups,
       COALESCE(sum(processing_fee_minor) FILTER (WHERE purpose = 'wallet_topup'), 0)::bigint AS topup_fees_minor,
       count(*) FILTER (WHERE purpose = 'job' AND provider = 'wallet')::int AS wallet_job_payments,
       COALESCE(json_agg(amount_minor) FILTER (WHERE purpose = 'job' AND provider = 'wallet'), '[]') AS wallet_job_amounts,
       (SELECT COALESCE(sum(amount_minor), 0) FROM wallet_ledger WHERE type = 'topup_bonus' AND created_at > now() - interval '90 days')::bigint AS bonuses_minor
     FROM payments WHERE status IN ('held', 'captured') AND created_at > now() - interval '90 days'`,
  );
  const avoided = (realised.wallet_job_amounts as number[]).reduce((a, amt) => a + collectionFee(amt, schedule), 0);
  const realisedMargin = avoided - Number(realised.topup_fees_minor) - Number(realised.bonuses_minor);

  const feeCfg = {
    standardFeeMinor: s.withdrawalStandardFeeMinor,
    instantFeeBps: s.withdrawalInstantFeeBps,
    instantMinMinor: s.withdrawalInstantFeeMinMinor,
    instantMaxMinor: s.withdrawalInstantFeeMaxMinor,
  };
  const withdrawals = [5_000, 25_000, 100_000, 500_000].map((naira) => {
    const amt = naira * 100;
    return { amountMinor: amt, ...withdrawalMargin(amt, withdrawalFee(amt, 'instant', feeCfg), schedule) };
  });

  return {
    provider,
    channel,
    schedule,
    averageJob: avg,
    tiers: tierEconomics(s.walletBonusTiers, schedule, avg.avgJobMinor, channel),
    realised90d: {
      topups: realised.topups,
      topupsMinor: Number(realised.topups_minor),
      topupFeesMinor: Number(realised.topup_fees_minor),
      bonusesMinor: Number(realised.bonuses_minor),
      walletJobPayments: realised.wallet_job_payments,
      avoidedJobFeesMinor: avoided,
      marginMinor: realisedMargin,
    },
    instantWithdrawals: withdrawals,
    notes: [
      'Margin = gateway fees avoided on wallet-paid jobs − fee to collect the top-up − bonus paid.',
      'Fee schedules are admin settings (gatewayFeeSchedules); confirm them against your signed rate card.',
    ],
  };
}
