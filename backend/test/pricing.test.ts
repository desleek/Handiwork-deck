import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  priceQuote,
  splitPayment,
  applyChallengedPrice,
  laborOnlyItems,
  applyNegotiatedLabor,
  computeTotals,
  type PricingContext,
  type QuoteItemInput,
} from '../src/domain/pricing.ts';
import { DEFAULT_SETTINGS as S } from '../src/domain/settings.ts';

const N = 100; // kobo per naira
const ctx: PricingContext = {
  markupCapBps: S.markupCapBps,
  receiptThresholdMinor: S.receiptThresholdMinor,
  laborCommissionBps: S.laborCommissionBps,
  markupCommissionBps: S.markupCommissionBps,
  multiplierBps: 0,
};

test('labor and parts stay separate; commission is 18% of labor + 20% of markup, 0 on base cost', () => {
  const q = priceQuote(
    [
      { kind: 'labor', description: 'Fix leaking pipe', quantity: 1, unitCostMinor: 20_000 * N },
      { kind: 'part', description: 'PVC elbow', quantity: 4, unitCostMinor: 2_500 * N, markupBps: 1000 },
    ],
    ctx,
  );
  assert.equal(q.issues.length, 0);
  assert.equal(q.lines[1].markupMinor, 1_000 * N); // 10% of ₦10,000
  assert.deepEqual(q.totals, {
    laborTotalMinor: 20_000 * N,
    partsBaseTotalMinor: 10_000 * N,
    markupTotalMinor: 1_000 * N,
    customerTotalMinor: 31_000 * N,
    laborCommissionMinor: 3_600 * N,
    markupCommissionMinor: 200 * N,
    platformCommissionMinor: 3_800 * N,
    technicianNetMinor: 27_200 * N,
  });
});

test('markup above the 20% cap is blocked, but eligible for a Demand Notice', () => {
  const q = priceQuote(
    [
      { kind: 'labor', description: 'Install', quantity: 1, unitCostMinor: 10_000 * N },
      { kind: 'part', description: 'Inverter battery', quantity: 1, unitCostMinor: 40_000 * N, markupBps: 3000 },
    ],
    ctx,
  );
  assert.equal(q.issues[0].code, 'MARKUP_OVER_CAP');
  assert.equal(q.issues[0].capBps, 2000);
  assert.equal(q.exceptionEligible, true);
});

test('an approved exception raises the cap for that line only', () => {
  const q = priceQuote(
    [
      { kind: 'labor', description: 'Install', quantity: 1, unitCostMinor: 10_000 * N },
      { kind: 'part', description: 'A', quantity: 1, unitCostMinor: 1_000 * N, markupBps: 3000, approvedExceptionCapBps: 3000 },
      { kind: 'part', description: 'B', quantity: 1, unitCostMinor: 1_000 * N, markupBps: 3000 },
    ],
    ctx,
  );
  assert.deepEqual(q.issues.map((i) => [i.code, i.position]), [['MARKUP_OVER_CAP', 3]]);
});

test('permanent per-technician override replaces the platform cap', () => {
  const q = priceQuote(
    [
      { kind: 'labor', description: 'x', quantity: 1, unitCostMinor: 100 },
      { kind: 'part', description: 'y', quantity: 1, unitCostMinor: 100, markupBps: 2500 },
    ],
    { ...ctx, technicianCapOverrideBps: 2500 },
  );
  assert.equal(q.issues.length, 0);
});

test('markup on labor and missing labor line are rejected', () => {
  const q = priceQuote([{ kind: 'part', description: 'x', quantity: 1, unitCostMinor: 100 }], ctx);
  assert.ok(q.issues.some((i) => i.code === 'NO_LABOR_LINE'));
  const q2 = priceQuote([{ kind: 'labor', description: 'x', quantity: 1, unitCostMinor: 100, markupBps: 500 }], ctx);
  assert.ok(q2.issues.some((i) => i.code === 'MARKUP_ON_LABOR'));
  assert.equal(q2.exceptionEligible, false);
});

test('parts above ₦50k require a receipt', () => {
  const items: QuoteItemInput[] = [
    { kind: 'labor', description: 'x', quantity: 1, unitCostMinor: 100 },
    { kind: 'part', description: 'AC compressor', quantity: 1, unitCostMinor: 60_000 * N },
  ];
  assert.equal(priceQuote(items, ctx).issues[0].code, 'RECEIPT_REQUIRED');
  items[1] = { ...items[1], receiptUrl: 'https://cdn/receipt.jpg' };
  assert.equal(priceQuote(items, ctx).issues.length, 0);
  // exactly at the threshold: not required
  const atThreshold = priceQuote(
    [items[0], { kind: 'part', description: 'x', quantity: 1, unitCostMinor: 50_000 * N }],
    ctx,
  );
  assert.equal(atThreshold.issues.length, 0);
});

test('performance multiplier applies to labor only', () => {
  const q = priceQuote(
    [
      { kind: 'labor', description: 'x', quantity: 2, unitCostMinor: 10_000 * N },
      { kind: 'part', description: 'y', quantity: 1, unitCostMinor: 5_000 * N, markupBps: 2000 },
    ],
    { ...ctx, multiplierBps: 1000 },
  );
  assert.equal(q.lines[0].baseLaborMinor, 10_000 * N);
  assert.equal(q.lines[0].unitCostMinor, 11_000 * N);
  assert.equal(q.totals.laborTotalMinor, 22_000 * N);
  assert.equal(q.totals.partsBaseTotalMinor, 5_000 * N);
  assert.equal(q.totals.markupTotalMinor, 1_000 * N);
  const down = priceQuote([{ kind: 'labor', description: 'x', quantity: 1, unitCostMinor: 10_000 * N }], {
    ...ctx,
    multiplierBps: -1000,
  });
  assert.equal(down.totals.laborTotalMinor, 9_000 * N);
});

test('split payment sums exactly to the customer total', () => {
  const q = priceQuote(
    [
      { kind: 'labor', description: 'x', quantity: 1, unitCostMinor: 12_345 },
      { kind: 'part', description: 'y', quantity: 3, unitCostMinor: 777, markupBps: 1500 },
    ],
    ctx,
  );
  const sum = splitPayment(q.totals).reduce((s, x) => s + x.amountMinor, 0);
  assert.equal(sum, q.totals.customerTotalMinor);
});

test('price challenge replaces base cost and keeps markup %', () => {
  const items = [
    { kind: 'labor' as const, description: 'x', quantity: 1, unitCostMinor: 1_000 },
    { kind: 'part' as const, description: 'y', quantity: 2, unitCostMinor: 5_000, markupBps: 2000 },
  ];
  const adj = priceQuote(applyChallengedPrice(items, 2, 4_000), ctx);
  assert.equal(adj.lines[1].unitCostMinor, 4_000);
  assert.equal(adj.lines[1].markupMinor, 1_600);
});

test('labor-only counter drops parts; negotiated labor rescales only labor lines', () => {
  const items = [
    { kind: 'labor' as const, description: 'a', quantity: 1, unitCostMinor: 6_000 },
    { kind: 'labor' as const, description: 'b', quantity: 1, unitCostMinor: 4_000 },
    { kind: 'part' as const, description: 'p', quantity: 1, unitCostMinor: 1_000, markupBps: 1000 },
  ];
  assert.equal(laborOnlyItems(items).length, 2);
  const priced = priceQuote(items, ctx);
  const lines = applyNegotiatedLabor(priced.lines, 8_001);
  const totals = computeTotals(lines, ctx);
  assert.equal(totals.laborTotalMinor, 8_001);
  assert.equal(totals.partsBaseTotalMinor, 1_000);
  assert.equal(totals.markupTotalMinor, 100);
});
