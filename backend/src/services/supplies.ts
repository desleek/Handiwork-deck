import { one, query, type Db } from '../db/pool.ts';
import { canMove, greenlightProgress } from '../domain/supplies.ts';
import type { PlatformSettings } from '../domain/settings.ts';
import { conflict, notFound } from '../lib/http.ts';
import { notify } from './notifications/notify.ts';
import { refundPayment } from './payments/escrow.ts';
import { postLedger } from './wallet.ts';

/** Supplies marketplace service (Section 13). Orders are escrowed like jobs: held on payment, released on receipt. */

export async function suppliesEnabled(s: PlatformSettings) {
  return s.features.supplies;
}

export async function greenlight(s: PlatformSettings, db?: Db) {
  const m = await one<any>(
    `SELECT (SELECT count(DISTINCT customer_id) FROM jobs WHERE created_at > now() - interval '30 days')::int AS mac,
            (SELECT count(*) FROM jobs WHERE status = 'completed' AND completed_at > now() - interval '30 days')::int AS jobs,
            (SELECT count(*) FROM parts_sellers WHERE verification_status = 'verified' AND merged_into IS NULL)::int AS sellers,
            (SELECT count(*) FROM supplies_waitlist)::int AS waitlist`,
    [],
    db,
  );
  return {
    ...greenlightProgress({ monthlyActiveCustomers: m.mac, completedJobs30d: m.jobs, verifiedSellers: m.sellers }, s.suppliesGreenlight),
    waitlist: m.waitlist,
  };
}

export async function getOrder(db: Db, id: string, forUpdate = false) {
  const o = await one<any>(`SELECT * FROM supply_orders WHERE id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [id], db);
  if (!o) throw notFound('Order');
  return o;
}

export async function moveOrder(db: Db, order: any, to: string, extra: Record<string, unknown> = {}) {
  if (!canMove(order.status, to)) throw conflict('INVALID_TRANSITION', `Cannot move a ${order.status.replace(/_/g, ' ')} order to ${to.replace(/_/g, ' ')}`);
  const sets = ['status = $2', 'updated_at = now()'];
  const vals: unknown[] = [order.id, to];
  for (const [k, v] of Object.entries(extra)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  if (to === 'paid') sets.push('paid_at = now()');
  if (to === 'dispatched' || to === 'ready_for_pickup') sets.push('dispatched_at = now()');
  if (to === 'completed') sets.push('received_at = now()');
  await query(`UPDATE supply_orders SET ${sets.join(', ')} WHERE id = $1`, vals, db);
  order.status = to;
}

/** Payment layer callback: order paid and held; stock is decremented now (refunded if it ran out meanwhile). */
export async function onSupplyOrderPaid(db: Db, p: any): Promise<(() => Promise<void>)[]> {
  const o = await getOrder(db, p.supply_order_id, true);
  const items = await query<{ product_id: string; quantity: number }>('SELECT product_id, quantity FROM supply_order_items WHERE order_id = $1', [o.id], db);
  let stockOk = o.status === 'pending_payment' && o.total_minor === p.amount_minor;
  const taken: { product_id: string; quantity: number }[] = [];
  if (stockOk) {
    for (const it of items) {
      const r = await query(
        `UPDATE supply_products SET stock_qty = stock_qty - $2, updated_at = now()
          WHERE id = $1 AND (stock_qty IS NULL OR stock_qty >= $2) RETURNING id`,
        [it.product_id, it.quantity],
        db,
      );
      if (!r.length) {
        stockOk = false;
        break;
      }
      taken.push(it);
    }
  }
  if (!stockOk) {
    // Put back anything decremented before the shortfall was found.
    for (const it of taken) await query('UPDATE supply_products SET stock_qty = stock_qty + $2 WHERE id = $1 AND stock_qty IS NOT NULL', [it.product_id, it.quantity], db);
  }
  if (!stockOk) {
    // Can't throw here (it would roll back the stock updates and the payment record): refund after commit instead.
    return [
      async () => {
        const { tx } = await import('../db/pool.ts');
        await tx(async (d) => {
          await refundPayment(d, p.id, p.amount_minor, `Refund: order #${o.short_code} could not be fulfilled`);
          await query(`UPDATE supply_orders SET status = 'cancelled', cancel_reason = 'Out of stock at payment', updated_at = now() WHERE id = $1 AND status = 'pending_payment'`, [o.id], d);
        });
        await notify({ userId: o.buyer_id, type: 'supplies.refunded', title: 'Order refunded', body: `Order #${o.short_code} couldn't be fulfilled (out of stock), so we've refunded you.` });
      },
    ];
  }
  await moveOrder(db, o, 'paid', { payment_id: p.id });
  const seller = await one<{ owner_user_id: string | null; name: string }>('SELECT owner_user_id, name FROM parts_sellers WHERE id = $1', [o.seller_id], db);
  return seller?.owner_user_id
    ? [() => notify({ userId: seller.owner_user_id!, type: 'supplies.new_order', title: `New order #${o.short_code}`, body: 'Accept it to start preparing the items.', channels: ['push', 'email'] })]
    : [];
}

/** Release escrow to the seller: goods net of commission + delivery fee into the seller owner's wallet. */
export async function releaseOrder(db: Db, orderId: string, opts: { refundMinor?: number } = {}) {
  const o = await getOrder(db, orderId, true);
  if (!['ready_for_pickup', 'dispatched', 'disputed'].includes(o.status)) throw conflict('NOT_RELEASABLE', `Order is ${o.status}`);
  const p = await one<any>(`SELECT * FROM payments WHERE id = $1 AND status = 'held' FOR UPDATE`, [o.payment_id], db);
  if (!p) throw conflict('NOT_PAID', 'No held payment for this order');
  const seller = await one<{ owner_user_id: string | null }>('SELECT owner_user_id FROM parts_sellers WHERE id = $1', [o.seller_id], db);
  if (!seller?.owner_user_id) throw conflict('NO_SELLER_ACCOUNT', 'This seller has no payout account linked');

  let total = o.total_minor;
  let commission = o.commission_minor;
  const refund = opts.refundMinor ?? 0;
  if (refund > 0) {
    await refundPayment(db, p.id, refund, `Order #${o.short_code} adjustment`);
    await query(`UPDATE payments SET status = 'held', amount_minor = amount_minor - $2 WHERE id = $1`, [p.id, refund], db);
    total -= refund;
    commission = Math.round((Math.max(0, total - o.delivery_fee_minor) * o.commission_bps) / 10_000);
  }
  const sellerNet = total - commission;
  await query(
    `INSERT INTO payment_splits (payment_id, recipient, user_id, component, amount_minor) VALUES
       ($1, 'seller', $2, 'supplies_sale', $3), ($1, 'platform', NULL, 'supplies_commission', $4)`,
    [p.id, seller.owner_user_id, sellerNet, commission],
    db,
  );
  await postLedger(db, { userId: seller.owner_user_id, type: 'supplies_sale', amountMinor: sellerNet, description: `Order #${o.short_code}`, paymentId: p.id });
  await query(`UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`, [p.id], db);
  if (o.status === 'disputed') {
    await query(`UPDATE supply_orders SET status = 'completed', received_at = now(), updated_at = now() WHERE id = $1`, [o.id], db);
  } else {
    await moveOrder(db, o, 'completed');
  }
  return { order: o, sellerNetMinor: sellerNet, sellerUserId: seller.owner_user_id };
}

export async function refreshSellerRating(db: Db, sellerId: string) {
  await query(
    `UPDATE parts_sellers SET rating_avg = r.avg, rating_count = r.n, updated_at = now()
       FROM (SELECT round(avg(rating)::numeric, 2) AS avg, count(*)::int AS n FROM supply_reviews WHERE seller_id = $1) r
      WHERE id = $1`,
    [sellerId],
    db,
  );
}

/** Seller account for the signed-in advertiser/seller user (Section 13 storefront). */
export async function sellerForUser(userId: string, db?: Db) {
  const s = await one<any>(`SELECT * FROM parts_sellers WHERE owner_user_id = $1 AND merged_into IS NULL ORDER BY created_at LIMIT 1`, [userId], db);
  if (!s) throw notFound('Seller account linked to this login');
  return s;
}
