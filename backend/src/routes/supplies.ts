import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.ts';
import { nextTier, priceOrder, type BulkTier, type ProductLike } from '../domain/supplies.ts';
import { badRequest, conflict, forbidden, HttpError, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { newShortCode } from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { refundPayment, startPayment } from '../services/payments/escrow.ts';
import { getSettings } from '../services/settings.ts';
import { getOrder, moveOrder, refreshSellerRating, releaseOrder, sellerForUser } from '../services/supplies.ts';

const uuid = z.string().uuid();
const toProduct = (r: any): ProductLike => ({ id: r.id, priceMinor: r.price_minor, bulkTiers: r.bulk_tiers ?? [], stockQty: r.stock_qty });

/** Buyer-facing Supplies marketplace (Section 13), mounted at /supplies. Off until an admin greenlights it. */
export const supplies = Router();
supplies.use(authenticate, requireUser());

supplies.get('/status', async (_req, res) => {
  const s = await getSettings();
  res.json({ enabled: s.features.supplies });
});

supplies.use(async (_req: Request, _res: Response, next: NextFunction) => {
  const s = await getSettings();
  if (!s.features.supplies) return next(new HttpError(404, 'SUPPLIES_NOT_LIVE', 'The Supplies marketplace is coming soon'));
  next();
});

supplies.get('/products', async (req, res) => {
  const q = parse(z.object({ search: z.string().trim().max(80).default(''), categoryId: uuid.optional(), sellerId: uuid.optional(), limit: z.coerce.number().int().min(1).max(60).default(30) }), req.query);
  const isTech = req.user!.role === 'technician';
  const rows = await query<any>(
    `SELECT p.*, s.name AS seller_name, s.rating_avg AS seller_rating, s.rating_count AS seller_rating_count, s.offers_delivery, s.delivery_fee_minor, s.pickup_address
       FROM supply_products p JOIN parts_sellers s ON s.id = p.seller_id
      WHERE p.is_active AND p.moderation_status = 'approved' AND s.storefront_status = 'live' AND s.verification_status IN ('provisional', 'verified')
        AND ($1 = '' OR to_tsvector('english', p.name || ' ' || coalesce(p.description, '')) @@ plainto_tsquery('english', $1) OR p.name ILIKE '%' || $1 || '%')
        AND ($2::uuid IS NULL OR $2 = ANY(p.category_ids)) AND ($3::uuid IS NULL OR p.seller_id = $3)
      ORDER BY s.rating_avg DESC NULLS LAST, p.created_at DESC LIMIT $4`,
    [q.search, q.categoryId ?? null, q.sellerId ?? null, q.limit],
  );
  res.json(
    rows.map((r) => ({
      ...r,
      // Show each buyer the tiers they actually qualify for (technician discount only to technicians).
      bulk_tiers: (r.bulk_tiers as BulkTier[]).filter((t) => t.audience === 'all' || isTech),
      in_stock: r.stock_qty === null || r.stock_qty > 0,
    })),
  );
});

supplies.get('/products/:id', async (req, res) => {
  const isTech = req.user!.role === 'technician';
  const p = await one<any>(
    `SELECT p.*, s.name AS seller_name, s.rating_avg AS seller_rating, s.rating_count AS seller_rating_count, s.offers_delivery, s.delivery_fee_minor, s.pickup_address
       FROM supply_products p JOIN parts_sellers s ON s.id = p.seller_id
      WHERE p.id = $1 AND p.is_active AND p.moderation_status = 'approved' AND s.storefront_status = 'live'`,
    [parse(uuid, req.params.id)],
  );
  if (!p) throw notFound('Product');
  const reviews = await query(
    `SELECT r.rating, r.review_text, r.created_at, split_part(u.full_name, ' ', 1) AS buyer FROM supply_reviews r JOIN users u ON u.id = r.buyer_id
      WHERE r.seller_id = $1 ORDER BY r.created_at DESC LIMIT 10`,
    [p.seller_id],
  );
  res.json({ ...p, bulk_tiers: (p.bulk_tiers as BulkTier[]).filter((t) => t.audience === 'all' || isTech), sellerReviews: reviews });
});

const OrderBody = z.object({
  sellerId: uuid,
  items: z.array(z.object({ productId: uuid, quantity: z.number().int().positive().max(100_000) })).min(1).max(50),
  fulfilment: z.enum(['delivery', 'pickup']),
  deliveryAddress: z.string().trim().min(5).max(500).optional(),
  jobId: uuid.optional(),
  note: z.string().max(1000).optional(),
});

async function quoteOrder(req: Request, b: z.infer<typeof OrderBody>) {
  const s = await getSettings();
  const seller = await one<any>(`SELECT * FROM parts_sellers WHERE id = $1 AND storefront_status = 'live'`, [b.sellerId]);
  if (!seller) throw notFound('Seller');
  const products = await query<any>(
    `SELECT * FROM supply_products WHERE id = ANY($1) AND seller_id = $2 AND is_active AND moderation_status = 'approved'`,
    [b.items.map((i) => i.productId), b.sellerId],
  );
  if (products.length !== new Set(b.items.map((i) => i.productId)).size) throw badRequest('UNKNOWN_PRODUCT', 'One or more items are unavailable from this seller');
  const byId = new Map(products.map((p) => [p.id, p]));
  const isTech = req.user!.role === 'technician';
  const priced = priceOrder(
    b.items.map((i) => ({ product: toProduct(byId.get(i.productId)), quantity: i.quantity })),
    { isTechnician: isTech, fulfilment: b.fulfilment, offersDelivery: seller.offers_delivery, deliveryFeeMinor: seller.delivery_fee_minor, commissionBps: s.suppliesCommissionBps },
  );
  return {
    seller,
    priced,
    lines: priced.lines.map((l) => {
      const p = byId.get(l.productId);
      return { ...l, name: p.name, unit: p.unit, nextTier: nextTier(toProduct(p), l.quantity, isTech) };
    }),
    commissionBps: s.suppliesCommissionBps,
  };
}

/** Price a basket before checkout (bulk/technician tiers, delivery fee, stock). */
supplies.post('/orders/quote', async (req, res) => {
  const b = parse(OrderBody, req.body);
  const q = await quoteOrder(req, b);
  const { lines: _l, ...rest } = q.priced;
  res.json({ ...rest, lines: q.lines, sellerName: q.seller.name });
});

supplies.post('/orders', async (req, res) => {
  const b = parse(OrderBody, req.body);
  if (b.fulfilment === 'delivery' && !b.deliveryAddress) throw badRequest('ADDRESS_REQUIRED', 'Add a delivery address');
  if (b.jobId) {
    const j = await one('SELECT 1 FROM jobs WHERE id = $1 AND (technician_id = $2 OR customer_id = $2)', [b.jobId, req.user!.id]);
    if (!j) throw notFound('Job');
  }
  const q = await quoteOrder(req, b);
  if (q.priced.issues.length) throw new HttpError(422, 'ORDER_INVALID', q.priced.issues[0].message, q.priced.issues);
  const order = await tx(async (db) => {
    const o = await one<any>(
      `INSERT INTO supply_orders (short_code, buyer_id, seller_id, job_id, fulfilment, delivery_address, subtotal_minor, discount_minor,
          delivery_fee_minor, total_minor, commission_bps, commission_minor, seller_net_minor, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
      [newShortCode().replace(/^HW/, 'SP'), req.user!.id, b.sellerId, b.jobId ?? null, b.fulfilment, b.fulfilment === 'delivery' ? b.deliveryAddress : null,
        q.priced.subtotalMinor, q.priced.discountMinor, q.priced.deliveryFeeMinor, q.priced.totalMinor, q.commissionBps, q.priced.commissionMinor,
        q.priced.sellerNetMinor, b.note ?? null],
      db,
    );
    for (const l of q.lines) {
      await query(
        `INSERT INTO supply_order_items (order_id, product_id, name, unit, quantity, list_price_minor, unit_price_minor, line_total_minor)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [o.id, l.productId, l.name, l.unit, l.quantity, l.listPriceMinor, l.unitPriceMinor, l.lineTotalMinor],
        db,
      );
    }
    return o;
  });
  res.status(201).json(order);
});

supplies.post('/orders/:id/pay', async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['card', 'bank_transfer', 'ussd', 'wallet']) }), req.body);
  const o = await one<any>('SELECT * FROM supply_orders WHERE id = $1 AND buyer_id = $2', [parse(uuid, req.params.id), req.user!.id]);
  if (!o) throw notFound('Order');
  if (o.status !== 'pending_payment') throw conflict('NOT_PAYABLE', `Order is ${o.status}`);
  const s = await getSettings();
  res.status(201).json(
    await startPayment({ payer: req.user!, purpose: 'supplies_order', amountMinor: o.total_minor, currency: s.currency, channel: b.channel, description: `Supplies order #${o.short_code}`, supplyOrderId: o.id, jobId: o.job_id ?? undefined }),
  );
});

supplies.get('/orders', async (req, res) => {
  res.json(
    await query(
      `SELECT o.*, s.name AS seller_name, (SELECT json_agg(i.* ORDER BY i.name) FROM supply_order_items i WHERE i.order_id = o.id) AS items,
              EXISTS (SELECT 1 FROM supply_reviews r WHERE r.order_id = o.id) AS reviewed
         FROM supply_orders o JOIN parts_sellers s ON s.id = o.seller_id WHERE o.buyer_id = $1 ORDER BY o.created_at DESC LIMIT 100`,
      [req.user!.id],
    ),
  );
});

/** Buyer confirms receipt → escrow released to the seller. */
supplies.post('/orders/:id/received', async (req, res) => {
  const out = await tx(async (db) => {
    const o = await getOrder(db, parse(uuid, req.params.id), true);
    if (o.buyer_id !== req.user!.id) throw notFound('Order');
    if (!['dispatched', 'ready_for_pickup'].includes(o.status)) throw conflict('NOT_READY', 'The seller has not dispatched this order yet');
    return releaseOrder(db, o.id);
  });
  await notify({ userId: out.sellerUserId, type: 'supplies.paid', title: `Order #${out.order.short_code} completed`, body: 'The buyer confirmed receipt. Payment is in your wallet.' });
  res.json({ ok: true, reviewPrompt: true });
});

supplies.post('/orders/:id/cancel', async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  await tx(async (db) => {
    const o = await getOrder(db, parse(uuid, req.params.id), true);
    if (o.buyer_id !== req.user!.id) throw notFound('Order');
    if (!['pending_payment', 'paid'].includes(o.status)) throw conflict('TOO_LATE', 'The seller has already accepted this order — open a dispute if there is a problem');
    if (o.status === 'paid') {
      const p = await one<any>(`SELECT * FROM payments WHERE id = $1 AND status = 'held'`, [o.payment_id], db);
      if (p) await refundPayment(db, p.id, p.amount_minor, `Refund: order #${o.short_code} cancelled`);
      for (const it of await query<any>('SELECT product_id, quantity FROM supply_order_items WHERE order_id = $1', [o.id], db)) {
        await query('UPDATE supply_products SET stock_qty = stock_qty + $2 WHERE id = $1 AND stock_qty IS NOT NULL', [it.product_id, it.quantity], db);
      }
    }
    await moveOrder(db, o, 'cancelled', { cancel_reason: b.reason });
  });
  res.json({ ok: true });
});

supplies.post('/orders/:id/dispute', async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(10).max(2000) }), req.body);
  await tx(async (db) => {
    const o = await getOrder(db, parse(uuid, req.params.id), true);
    if (o.buyer_id !== req.user!.id) throw notFound('Order');
    await moveOrder(db, o, 'disputed', { note: `${o.note ? o.note + '\n' : ''}Dispute: ${b.reason}` });
  });
  res.status(201).json({ ok: true });
});

/** Supplier reviews (Section 13), only for completed orders. */
supplies.post('/orders/:id/review', async (req, res) => {
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), review: z.string().trim().max(2000).optional() }), req.body);
  await tx(async (db) => {
    const o = await getOrder(db, parse(uuid, req.params.id), true);
    if (o.buyer_id !== req.user!.id) throw notFound('Order');
    if (o.status !== 'completed') throw conflict('NOT_COMPLETED', 'You can review a seller once the order is complete');
    await query('INSERT INTO supply_reviews (order_id, buyer_id, seller_id, rating, review_text) VALUES ($1,$2,$3,$4,$5)', [o.id, o.buyer_id, o.seller_id, b.rating, b.review ?? null], db);
    await refreshSellerRating(db, o.seller_id);
  });
  res.status(201).json({ ok: true });
});

// =========================================================================== seller storefront

/** Seller-side API for advertisers who run a storefront, mounted at /seller. */
export const seller = Router();
seller.use(authenticate, requireUser('advertiser'));

seller.get('/storefront', async (req, res) => {
  const s = await sellerForUser(req.user!.id);
  const stats = await one(
    `SELECT count(*) FILTER (WHERE status IN ('paid', 'accepted'))::int AS to_fulfil,
            COALESCE(sum(seller_net_minor) FILTER (WHERE status = 'completed' AND received_at > now() - interval '30 days'), 0)::bigint AS earned_30d_minor
       FROM supply_orders WHERE seller_id = $1`,
    [s.id],
  );
  res.json({ ...s, stats });
});

seller.put('/storefront', async (req, res) => {
  const b = parse(
    z.object({ pickupAddress: z.string().trim().min(5).max(500), offersDelivery: z.boolean(), deliveryFeeMinor: z.number().int().min(0).max(10_000_000), requestLive: z.boolean().default(false) }),
    req.body,
  );
  const s = await sellerForUser(req.user!.id);
  const r = await one(
    `UPDATE parts_sellers SET pickup_address = $2, offers_delivery = $3, delivery_fee_minor = $4, updated_at = now(),
       storefront_status = CASE WHEN $5 AND storefront_status = 'none' THEN 'pending' ELSE storefront_status END
     WHERE id = $1 RETURNING *`,
    [s.id, b.pickupAddress, b.offersDelivery, b.deliveryFeeMinor, b.requestLive],
  );
  res.json(r);
});

const Tier = z.object({ minQty: z.number().int().min(2), unitPriceMinor: z.number().int().positive(), audience: z.enum(['all', 'technician']) });
const ProductBody = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  categoryIds: z.array(uuid).max(10).default([]),
  unit: z.string().trim().min(1).max(20).default('each'),
  priceMinor: z.number().int().positive(),
  bulkTiers: z.array(Tier).max(10).default([]),
  stockQty: z.number().int().min(0).nullable().optional(),
  imageUrls: z.array(z.string().url()).max(6).default([]),
  isActive: z.boolean().default(true),
});

function checkTiers(priceMinor: number, tiers: z.infer<typeof Tier>[]) {
  for (const t of tiers) if (t.unitPriceMinor >= priceMinor) throw badRequest('TIER_NOT_DISCOUNT', 'Bulk prices must be lower than the list price');
}

seller.get('/products', async (req, res) => {
  const s = await sellerForUser(req.user!.id);
  res.json(await query('SELECT * FROM supply_products WHERE seller_id = $1 ORDER BY created_at DESC', [s.id]));
});

seller.post('/products', async (req, res) => {
  const b = parse(ProductBody, req.body);
  checkTiers(b.priceMinor, b.bulkTiers);
  const s = await sellerForUser(req.user!.id);
  res.status(201).json(
    await one(
      `INSERT INTO supply_products (seller_id, name, description, category_ids, unit, price_minor, bulk_tiers, stock_qty, image_urls, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [s.id, b.name, b.description ?? null, b.categoryIds, b.unit, b.priceMinor, JSON.stringify(b.bulkTiers), b.stockQty ?? null, b.imageUrls, b.isActive],
    ),
  );
});

seller.patch('/products/:id', async (req, res) => {
  const b = parse(ProductBody.partial(), req.body);
  const s = await sellerForUser(req.user!.id);
  const cur = await one<any>('SELECT * FROM supply_products WHERE id = $1 AND seller_id = $2', [parse(uuid, req.params.id), s.id]);
  if (!cur) throw notFound('Product');
  checkTiers(b.priceMinor ?? cur.price_minor, b.bulkTiers ?? cur.bulk_tiers);
  // Changing what buyers see (name, description, images) goes back to moderation; price/stock changes don't.
  const remoderate = b.name !== undefined || b.description !== undefined || b.imageUrls !== undefined;
  res.json(
    await one(
      `UPDATE supply_products SET name = COALESCE($2, name), description = COALESCE($3, description), category_ids = COALESCE($4, category_ids),
         unit = COALESCE($5, unit), price_minor = COALESCE($6, price_minor), bulk_tiers = COALESCE($7, bulk_tiers),
         stock_qty = CASE WHEN $8 THEN $9 ELSE stock_qty END, image_urls = COALESCE($10, image_urls), is_active = COALESCE($11, is_active),
         moderation_status = CASE WHEN $12 THEN 'pending'::moderation_status ELSE moderation_status END, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [cur.id, b.name ?? null, b.description ?? null, b.categoryIds ?? null, b.unit ?? null, b.priceMinor ?? null,
        b.bulkTiers ? JSON.stringify(b.bulkTiers) : null, b.stockQty !== undefined, b.stockQty ?? null, b.imageUrls ?? null, b.isActive ?? null, remoderate],
    ),
  );
});

seller.get('/orders', async (req, res) => {
  const q = parse(z.object({ status: z.string().optional() }), req.query);
  const s = await sellerForUser(req.user!.id);
  res.json(
    await query(
      `SELECT o.*, split_part(u.full_name, ' ', 1) AS buyer_name, u.role AS buyer_role,
              (SELECT json_agg(i.* ORDER BY i.name) FROM supply_order_items i WHERE i.order_id = o.id) AS items
         FROM supply_orders o JOIN users u ON u.id = o.buyer_id
        WHERE o.seller_id = $1 AND o.status <> 'pending_payment' AND ($2::text IS NULL OR o.status = $2)
        ORDER BY o.created_at DESC LIMIT 200`,
      [s.id, q.status ?? null],
    ),
  );
});

const SELLER_ACTIONS: Record<string, string> = { accept: 'accepted', reject: 'rejected', ready: 'ready_for_pickup', dispatch: 'dispatched' };

seller.post('/orders/:id/:action', async (req, res) => {
  const to = SELLER_ACTIONS[req.params.action];
  if (!to) throw notFound('Action');
  const b = parse(z.object({ reason: z.string().trim().max(500).optional() }), req.body ?? {});
  const s = await sellerForUser(req.user!.id);
  const out = await tx(async (db) => {
    const o = await getOrder(db, parse(uuid, req.params.id), true);
    if (o.seller_id !== s.id) throw forbidden('NOT_YOUR_ORDER', 'This order belongs to another seller');
    if (to === 'ready_for_pickup' && o.fulfilment !== 'pickup') throw conflict('NOT_PICKUP', 'This order is for delivery');
    if (to === 'dispatched' && o.fulfilment !== 'delivery') throw conflict('NOT_DELIVERY', 'This order is for pickup');
    if (to === 'rejected') {
      if (!b.reason) throw badRequest('REASON_REQUIRED', 'Tell the buyer why');
      const p = await one<any>(`SELECT * FROM payments WHERE id = $1 AND status = 'held'`, [o.payment_id], db);
      if (p) await refundPayment(db, p.id, p.amount_minor, `Refund: order #${o.short_code} declined by seller`);
      for (const it of await query<any>('SELECT product_id, quantity FROM supply_order_items WHERE order_id = $1', [o.id], db)) {
        await query('UPDATE supply_products SET stock_qty = stock_qty + $2 WHERE id = $1 AND stock_qty IS NOT NULL', [it.product_id, it.quantity], db);
      }
    }
    await moveOrder(db, o, to, to === 'rejected' ? { cancel_reason: b.reason } : {});
    return o;
  });
  const text: Record<string, string> = {
    accepted: 'The seller accepted your order and is preparing it.',
    rejected: `The seller couldn't fulfil your order (${b.reason ?? ''}). You've been refunded.`,
    ready_for_pickup: 'Your order is ready for pickup.',
    dispatched: 'Your order is on its way.',
  };
  await notify({ userId: out.buyer_id, type: `supplies.${to}`, title: `Order #${out.short_code}`, body: text[to] });
  res.json({ ok: true });
});
