import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bonusEconomics, breakEvenBonusBps, collectionFee, DEFAULT_FEE_SCHEDULES, transferFee, withdrawalMargin } from '../src/domain/fees.ts';
import { DEFAULT_SETTINGS as S } from '../src/domain/settings.ts';
import { withdrawalFee } from '../src/domain/wallet.ts';

const N = 100;
const PS = DEFAULT_FEE_SCHEDULES.paystack;
const FW = DEFAULT_FEE_SCHEDULES.flutterwave;

test('Paystack local fee: 1.5% + ₦100, flat waived under ₦2,500, capped at ₦2,000', () => {
  assert.equal(collectionFee(2_000 * N, PS), 30 * N);
  assert.equal(collectionFee(10_000 * N, PS), 250 * N);
  assert.equal(collectionFee(1_000_000 * N, PS), 2_000 * N);
  assert.equal(collectionFee(100_000 * N, PS, 'virtual_account'), 300 * N);
  assert.equal(collectionFee(10_000 * N, PS, 'virtual_account'), 100 * N);
});

test('Flutterwave local fee: 1.4% capped at ₦2,000', () => {
  assert.equal(collectionFee(10_000 * N, FW), 140 * N);
  assert.equal(collectionFee(500_000 * N, FW), 2_000 * N);
});

test('transfer bands', () => {
  assert.equal(transferFee(5_000 * N, PS), 10 * N);
  assert.equal(transferFee(20_000 * N, PS), 25 * N);
  assert.equal(transferFee(200_000 * N, PS), 50 * N);
});

test('every default bonus tier is funded by fee savings at a ₦25k average job (Paystack, card top-up)', () => {
  for (const tier of S.walletBonusTiers.filter((t) => t.bonusBps > 0)) {
    for (const amt of [tier.minTopupMinor, tier.maxTopupMinor ? tier.maxTopupMinor - 1 : tier.minTopupMinor * 4]) {
      const r = bonusEconomics({ topupMinor: amt, bonusBps: tier.bonusBps, avgJobMinor: S.economicsAvgJobMinor, schedule: PS });
      assert.ok(r.funded, `₦${amt / N} at ${tier.bonusBps}bps → margin ₦${r.marginMinor / N}`);
    }
  }
});

test('small tiers stop being funded when the average job is large (one job ≈ one top-up)', () => {
  const r = bonusEconomics({ topupMinor: 50_000 * N, bonusBps: 10, avgJobMinor: 50_000 * N, schedule: PS });
  assert.equal(r.funded, false);
  // Virtual-account top-ups are much cheaper to collect, which restores the margin.
  const va = bonusEconomics({ topupMinor: 50_000 * N, bonusBps: 10, avgJobMinor: 50_000 * N, schedule: PS, topupChannel: 'virtual_account' });
  assert.equal(va.funded, true);
});

test('break-even bonus grows with top-up size because the top-up fee is capped', () => {
  const small = breakEvenBonusBps({ topupMinor: 50_000 * N, avgJobMinor: 25_000 * N, schedule: PS });
  const large = breakEvenBonusBps({ topupMinor: 1_000_000 * N, avgJobMinor: 25_000 * N, schedule: PS });
  assert.ok(large > small, `${small} vs ${large}`);
  assert.ok(bonusEconomics({ topupMinor: 1_000_000 * N, bonusBps: large, avgJobMinor: 25_000 * N, schedule: PS }).funded);
  assert.ok(!bonusEconomics({ topupMinor: 1_000_000 * N, bonusBps: large + 1, avgJobMinor: 25_000 * N, schedule: PS }).funded);
});

test('instant withdrawal fee covers the transfer cost', () => {
  const cfg = { standardFeeMinor: 0, instantFeeBps: S.withdrawalInstantFeeBps, instantMinMinor: S.withdrawalInstantFeeMinMinor, instantMaxMinor: S.withdrawalInstantFeeMaxMinor };
  for (const amt of [1_000, 10_000, 100_000, 1_000_000].map((x) => x * N)) {
    assert.ok(withdrawalMargin(amt, withdrawalFee(amt, 'instant', cfg), PS).marginMinor > 0);
  }
});
