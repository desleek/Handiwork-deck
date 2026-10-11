import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bandFor, canFundMilestone, checkConsultancyFee, consultancySplit, noShowDecision, priceBoq, type BoqItemInput } from '../src/domain/construction.ts';
import { DEFAULT_SETTINGS as S } from '../src/domain/settings.ts';

const N = 100;
const H = 3_600_000;
const now = new Date('2026-10-11T12:00:00Z');
const ctx = { markupCapBps: S.markupCapBps, laborCommissionBps: S.laborCommissionBps, markupCommissionBps: S.markupCommissionBps, multiplierBps: 0 };

test('consultancy fee must sit inside the trade band; per-trade bands override the default', () => {
  const band = bandFor('c-roofing', { 'c-roofing': { minMinor: 20_000 * N, maxMinor: 60_000 * N } }, S.consultancyDefaultBand);
  assert.equal(checkConsultancyFee(30_000 * N, band).ok, true);
  assert.equal(checkConsultancyFee(70_000 * N, band).ok, false);
  assert.deepEqual(bandFor('c-tiling', {}, S.consultancyDefaultBand), S.consultancyDefaultBand);
  assert.deepEqual(consultancySplit(50_000 * N, 1000), { commissionMinor: 5_000 * N, technicianMinor: 45_000 * N });
});

test('no-show refund: only after the grace period, and a dispute if the technician says they visited', () => {
  const base = { status: 'paid', visitAt: new Date(now.getTime() - 4 * H), visitedAt: null, now, graceHours: 3, refundOnNoShow: true };
  assert.equal(noShowDecision(base), 'refund');
  assert.equal(noShowDecision({ ...base, visitAt: new Date(now.getTime() - 2 * H) }), 'too_early');
  assert.equal(noShowDecision({ ...base, visitedAt: new Date() }), 'dispute');
  assert.equal(noShowDecision({ ...base, refundOnNoShow: false }), 'not_refundable');
  assert.equal(noShowDecision({ ...base, status: 'quoted' }), 'invalid');
});

const items: BoqItemInput[] = [
  { kind: 'part', description: 'Concrete', unit: 'm3', quantity: 12, unitRateMinor: 85_000 * N, markupBps: 1000, milestone: 1 },
  { kind: 'labor', description: 'Foundation labour', unit: 'item', quantity: 1, unitRateMinor: 200_000 * N, milestone: 1 },
  { kind: 'part', description: 'Blocks', unit: 'nr', quantity: 1800, unitRateMinor: 650 * N, markupBps: 500, milestone: 2 },
  { kind: 'labor', description: 'Bricklaying', unit: 'm2', quantity: 220, unitRateMinor: 1_500 * N, milestone: 2 },
];

test('BOQ is priced per milestone with commission per milestone, and totals reconcile', () => {
  const r = priceBoq(items, [{ title: 'Foundation' }, { title: 'Walls' }], ctx, 12);
  assert.deepEqual(r.issues, []);
  const [m1, m2] = r.milestones;
  assert.equal(m1.totals.laborTotalMinor, 200_000 * N);
  assert.equal(m1.totals.partsBaseTotalMinor, 1_020_000 * N);
  assert.equal(m1.totals.markupTotalMinor, 102_000 * N);
  assert.equal(m1.totals.laborCommissionMinor, 36_000 * N); // 18% of labor
  assert.equal(m1.totals.markupCommissionMinor, 20_400 * N); // 20% of markup, 0 on base
  assert.equal(m2.totals.customerTotalMinor, 1_170_000 * N + 58_500 * N + 330_000 * N);
  assert.equal(r.totals.customerTotalMinor, m1.totals.customerTotalMinor + m2.totals.customerTotalMinor);
  assert.equal(r.totals.technicianNetMinor + r.totals.platformCommissionMinor, r.totals.customerTotalMinor);
});

test('BOQ enforces the markup cap, units, and milestone assignment', () => {
  const bad = priceBoq(
    [{ ...items[0], markupBps: 3500 }, { ...items[1], unit: '' }, { ...items[2], milestone: 3 }],
    [{ title: 'Foundation' }, { title: 'Walls' }],
    ctx,
    12,
  );
  const codes = bad.issues.map((i) => i.code).sort();
  assert.deepEqual(codes, ['EMPTY_MILESTONE', 'MARKUP_OVER_CAP', 'MISSING_UNIT', 'UNASSIGNED_LINE']);
  assert.equal(priceBoq(items, [], ctx, 12).issues.some((i) => i.code === 'NO_MILESTONES'), true);
});

test('milestones are funded in order', () => {
  const ms = [{ position: 1, status: 'released' }, { position: 2, status: 'pending' }, { position: 3, status: 'pending' }];
  assert.equal(canFundMilestone(2, ms), true);
  assert.equal(canFundMilestone(3, ms), false);
  assert.equal(canFundMilestone(1, ms), false);
});
