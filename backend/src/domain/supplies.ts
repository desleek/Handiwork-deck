/**
 * Supplies marketplace rules (Section 13): parts, tools and materials sold by verified sellers,
 * with bulk pricing and technician bulk-ordering discounts, delivery or pickup, and escrow.
 */
import { applyBps } from './pricing.ts';

export interface BulkTier {
  minQty: number;
  unitPriceMinor: number;
  /** "technician" tiers are the technician bulk-ordering discount; "all" applies to every buyer. */
  audience: 'all' | 'technician';
}

export interface ProductLike {
  id: string;
  priceMinor: number;
  bulkTiers: BulkTier[];
  stockQty: number | null;
}

/** Best price the buyer qualifies for at this quantity; never above list price. */
export function unitPriceFor(p: ProductLike, qty: number, isTechnician: boolean): { unitPriceMinor: number; tier: BulkTier | null } {
  let best: BulkTier | null = null;
  for (const t of p.bulkTiers) {
    if (qty < t.minQty) continue;
    if (t.audience === 'technician' && !isTechnician) continue;
    if (!best || t.unitPriceMinor < best.unitPriceMinor) best = t;
  }
  return best && best.unitPriceMinor < p.priceMinor ? { unitPriceMinor: best.unitPriceMinor, tier: best } : { unitPriceMinor: p.priceMinor, tier: null };
}

/** The next quantity break the buyer could reach, for "buy 5 more to pay ₦X each" hints. */
export function nextTier(p: ProductLike, qty: number, isTechnician: boolean): BulkTier | null {
  const current = unitPriceFor(p, qty, isTechnician).unitPriceMinor;
  return (
    p.bulkTiers
      .filter((t) => t.minQty > qty && t.unitPriceMinor < current && (t.audience === 'all' || isTechnician))
      .sort((a, b) => a.minQty - b.minQty)[0] ?? null
  );
}

export interface OrderLineInput {
  product: ProductLike;
  quantity: number;
}

export type OrderIssue = { code: 'INVALID_QTY' | 'OUT_OF_STOCK' | 'EMPTY' | 'NO_DELIVERY'; productId?: string; message: string };

export function priceOrder(
  lines: OrderLineInput[],
  p: { isTechnician: boolean; fulfilment: 'delivery' | 'pickup'; offersDelivery: boolean; deliveryFeeMinor: number; commissionBps: number },
) {
  const issues: OrderIssue[] = [];
  if (lines.length === 0) issues.push({ code: 'EMPTY', message: 'Add at least one item' });
  if (p.fulfilment === 'delivery' && !p.offersDelivery) issues.push({ code: 'NO_DELIVERY', message: 'This seller offers pickup only' });
  const priced = lines.map(({ product, quantity }) => {
    if (!Number.isInteger(quantity) || quantity < 1) issues.push({ code: 'INVALID_QTY', productId: product.id, message: 'Quantities must be whole numbers' });
    if (product.stockQty !== null && quantity > product.stockQty) {
      issues.push({ code: 'OUT_OF_STOCK', productId: product.id, message: `Only ${product.stockQty} left in stock` });
    }
    const { unitPriceMinor, tier } = unitPriceFor(product, quantity, p.isTechnician);
    return {
      productId: product.id,
      quantity,
      listPriceMinor: product.priceMinor,
      unitPriceMinor,
      tier,
      lineTotalMinor: unitPriceMinor * quantity,
      listTotalMinor: product.priceMinor * quantity,
    };
  });
  const subtotalMinor = priced.reduce((a, l) => a + l.listTotalMinor, 0);
  const discountMinor = subtotalMinor - priced.reduce((a, l) => a + l.lineTotalMinor, 0);
  const deliveryFeeMinor = p.fulfilment === 'delivery' ? p.deliveryFeeMinor : 0;
  const goodsMinor = subtotalMinor - discountMinor;
  // Platform commission is on goods only — the delivery fee goes to the seller in full.
  const commissionMinor = applyBps(goodsMinor, p.commissionBps);
  const totalMinor = goodsMinor + deliveryFeeMinor;
  return { lines: priced, subtotalMinor, discountMinor, deliveryFeeMinor, totalMinor, commissionMinor, sellerNetMinor: totalMinor - commissionMinor, issues };
}

/** Allowed order transitions; anything else is a 409. */
export const ORDER_TRANSITIONS: Record<string, string[]> = {
  pending_payment: ['paid', 'cancelled'],
  paid: ['accepted', 'rejected', 'cancelled', 'disputed'],
  accepted: ['ready_for_pickup', 'dispatched', 'disputed', 'cancelled'],
  ready_for_pickup: ['completed', 'disputed'],
  dispatched: ['completed', 'disputed'],
  disputed: ['completed', 'refunded'],
};

export function canMove(from: string, to: string) {
  return (ORDER_TRANSITIONS[from] ?? []).includes(to);
}

export interface GreenlightMetrics {
  monthlyActiveCustomers: number;
  completedJobs30d: number;
  verifiedSellers: number;
}

/** Section 13: admin-defined traction milestones are the greenlight signal for the Supplies marketplace. */
export function greenlightProgress(
  m: GreenlightMetrics,
  t: { minMonthlyActiveCustomers: number; minCompletedJobs30d: number; minVerifiedSellers: number },
) {
  const items = [
    { key: 'monthlyActiveCustomers', label: 'Monthly active customers', value: m.monthlyActiveCustomers, target: t.minMonthlyActiveCustomers },
    { key: 'completedJobs30d', label: 'Completed jobs (30 days)', value: m.completedJobs30d, target: t.minCompletedJobs30d },
    { key: 'verifiedSellers', label: 'Verified sellers', value: m.verifiedSellers, target: t.minVerifiedSellers },
  ].map((i) => ({ ...i, met: i.value >= i.target, pct: i.target === 0 ? 100 : Math.min(100, Math.round((i.value / i.target) * 100)) }));
  return { met: items.every((i) => i.met), items };
}
