import type pg from 'pg';
import { one } from '../db/pool';
import { getSetting } from './settings';

/**
 * Section 16 promotions: turns a paid purchase into a visibility boost or a
 * priority-alert subscription. Buying again extends the running period. Called
 * at purchase time for wallet payments, or from the payment webhook for
 * gateway payments (Section 11: promotions use the same payment layer as jobs).
 */
export async function activatePromotion(db: pg.PoolClient, purchaseId: string) {
  const p = await one(`SELECT * FROM promotion_purchases WHERE id = $1 FOR UPDATE`, [purchaseId], db);
  if (!p) throw new Error(`promotion purchase ${purchaseId} not found`);
  if (p.boost_id || p.alert_subscription_id) return null; // already active
  const { products } = await getSetting('promotions', db);
  const product = products[p.product];
  if (!product) {
    await db.query(`UPDATE promotion_purchases SET status = 'failed' WHERE id = $1`, [purchaseId]);
    return null;
  }
  await db.query(`UPDATE promotion_purchases SET status = 'active' WHERE id = $1`, [purchaseId]);
  if (product.kind === 'boost') {
    const boost = await one(
      `INSERT INTO technician_boosts (technician_id, category_id, priority, starts_at, ends_at, source)
       SELECT $1, $2, $3, s, s + make_interval(days => $4), 'purchase'
         FROM (SELECT greatest(now(), coalesce(max(ends_at), now())) AS s FROM technician_boosts
                WHERE technician_id = $1 AND source = 'purchase' AND category_id IS NOT DISTINCT FROM $2) x
       RETURNING id, starts_at, ends_at`,
      [p.technician_id, p.category_id ?? null, product.priority ?? 10, product.days],
      db,
    );
    await db.query('UPDATE promotion_purchases SET boost_id = $2 WHERE id = $1', [purchaseId, boost.id]);
    return { id: purchaseId, kind: 'boost' as const, status: 'active', startsAt: boost.starts_at, endsAt: boost.ends_at };
  }
  const sub = await one(
    `INSERT INTO technician_alert_subscriptions (technician_id, radius_factor, starts_at, ends_at)
     SELECT $1, $2, s, s + make_interval(days => $3)
       FROM (SELECT greatest(now(), coalesce(max(ends_at), now())) AS s FROM technician_alert_subscriptions WHERE technician_id = $1) x
     RETURNING id, starts_at, ends_at`,
    [p.technician_id, product.radiusFactor ?? 2, product.days],
    db,
  );
  await db.query('UPDATE promotion_purchases SET alert_subscription_id = $2 WHERE id = $1', [purchaseId, sub.id]);
  return { id: purchaseId, kind: 'alerts' as const, status: 'active', startsAt: sub.starts_at, endsAt: sub.ends_at };
}
