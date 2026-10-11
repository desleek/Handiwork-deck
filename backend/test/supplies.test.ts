import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canMove, greenlightProgress, nextTier, priceOrder, unitPriceFor, type ProductLike } from '../src/domain/supplies.ts';
import { DEFAULT_SETTINGS as S } from '../src/domain/settings.ts';

const N = 100;
const cement: ProductLike = {
  id: 'cement',
  priceMinor: 9_500 * N,
  stockQty: 500,
  bulkTiers: [
    { minQty: 20, unitPriceMinor: 9_200 * N, audience: 'all' },
    { minQty: 50, unitPriceMinor: 9_000 * N, audience: 'all' },
    { minQty: 20, unitPriceMinor: 8_900 * N, audience: 'technician' },
  ],
};

test('bulk tiers apply by quantity; technician tiers only to technicians', () => {
  assert.equal(unitPriceFor(cement, 10, false).unitPriceMinor, 9_500 * N);
  assert.equal(unitPriceFor(cement, 20, false).unitPriceMinor, 9_200 * N);
  assert.equal(unitPriceFor(cement, 60, false).unitPriceMinor, 9_000 * N);
  assert.equal(unitPriceFor(cement, 20, true).unitPriceMinor, 8_900 * N);
  assert.deepEqual(nextTier(cement, 10, false), { minQty: 20, unitPriceMinor: 9_200 * N, audience: 'all' });
  // A misconfigured tier above list price is ignored.
  assert.equal(unitPriceFor({ ...cement, bulkTiers: [{ minQty: 1, unitPriceMinor: 99_999 * N, audience: 'all' }] }, 5, false).unitPriceMinor, 9_500 * N);
});

test('order pricing: discount shown, commission on goods only, delivery fee to seller', () => {
  const o = priceOrder([{ product: cement, quantity: 20 }], { isTechnician: true, fulfilment: 'delivery', offersDelivery: true, deliveryFeeMinor: 5_000 * N, commissionBps: S.suppliesCommissionBps });
  assert.equal(o.subtotalMinor, 190_000 * N);
  assert.equal(o.discountMinor, 12_000 * N);
  assert.equal(o.totalMinor, 183_000 * N);
  assert.equal(o.commissionMinor, 8_900 * N); // 5% of ₦178,000 goods
  assert.equal(o.sellerNetMinor + o.commissionMinor, o.totalMinor);
  assert.deepEqual(o.issues, []);
});

test('order validation: stock, delivery availability, quantities', () => {
  const o = priceOrder([{ product: cement, quantity: 600 }, { product: cement, quantity: 1.5 }], { isTechnician: false, fulfilment: 'delivery', offersDelivery: false, deliveryFeeMinor: 0, commissionBps: 500 });
  assert.deepEqual(o.issues.map((i) => i.code).sort(), ['INVALID_QTY', 'NO_DELIVERY', 'OUT_OF_STOCK']);
});

test('order transitions', () => {
  assert.equal(canMove('paid', 'accepted'), true);
  assert.equal(canMove('pending_payment', 'dispatched'), false);
  assert.equal(canMove('dispatched', 'completed'), true);
});

test('greenlight progress against admin traction milestones', () => {
  const g = greenlightProgress({ monthlyActiveCustomers: 2500, completedJobs30d: 400, verifiedSellers: 30 }, S.suppliesGreenlight);
  assert.equal(g.met, false);
  assert.deepEqual(g.items.map((i) => [i.key, i.met, i.pct]), [['monthlyActiveCustomers', true, 100], ['completedJobs30d', false, 40], ['verifiedSellers', true, 100]]);
});
