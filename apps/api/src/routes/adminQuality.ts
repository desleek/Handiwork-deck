import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { audit } from '../services/audit';
import { applyChallengedPrices } from '../services/priceChallenges';
import { recalcRateAdjustment } from '../services/rateAdjustment';
import { recomputeTechnicianRating } from '../services/ratings';

/** Admin tools for Sections 6 & 7: price challenges, seller registry, flags, rate adjustments, penalties. */
export const adminQualityRouter = Router();
adminQualityRouter.use('/admin', authenticate, requireUser('admin'));

// ---------------------------------------------------------------- price challenges (6c)
adminQualityRouter.get('/admin/price-challenges', async (req, res) => {
  const { status } = parse(z.object({ status: z.string().default('pending') }), req.query);
  const challenges = await query(
    `SELECT pc.*, j.ref AS job_ref, j.title AS job_title, t.full_name AS technician_name, c.full_name AS customer_name,
            (SELECT json_agg(l) FROM price_challenge_lines l WHERE l.challenge_id = pc.id) AS lines,
            (SELECT json_agg(json_build_object('id', f.id, 'url', f.url, 'seller', s.name, 'sellerVerified', s.is_verified))
               FROM files f JOIN spare_parts_sellers s ON s.id = f.seller_id WHERE f.id = ANY(pc.evidence_file_ids)) AS evidence
       FROM price_challenges pc JOIN jobs j ON j.id = pc.job_id JOIN users t ON t.id = pc.technician_id JOIN users c ON c.id = pc.customer_id
      WHERE pc.status = $1::price_challenge_status
      -- Fast Track first, then escalated, then oldest.
      ORDER BY pc.fast_track DESC, (pc.escalated_at IS NOT NULL) DESC, pc.created_at LIMIT 200`,
    [status],
  );
  res.json({ challenges });
});

adminQualityRouter.post('/admin/price-challenges/:id/resolve', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({ decision: z.enum(['approve_customer', 'uphold_technician']), note: z.string().trim().max(1000).optional() }), req.body);
  const admin = currentUser(req);
  const c = await tx(async (db) => {
    const c = await one(`SELECT * FROM price_challenges WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) throw notFound('Price challenge');
    if (c.status !== 'pending') throw conflict(`Challenge is already ${c.status}`);
    await db.query('SELECT 1 FROM quotes WHERE id = $1 FOR UPDATE', [c.quote_id]);
    if (b.decision === 'approve_customer') await applyChallengedPrices(db, id);
    const status = b.decision === 'approve_customer' ? 'admin_approved' : 'admin_upheld';
    await db.query(`UPDATE price_challenges SET status = $2, resolved_at = now(), resolved_by = $3, resolution_note = $4 WHERE id = $1`, [id, status, admin.id, b.note ?? null]);
    await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1 AND status = 'countered'`, [c.quote_id]);
    await audit(c.job_id, admin.id, `price_challenge.${status}`, { challengeId: id, note: b.note ?? null }, db);
    return c;
  });
  const msg = b.decision === 'approve_customer' ? "Our team applied the customer's evidenced prices." : "Our team upheld the technician's prices.";
  for (const u of [c.customer_id, c.technician_id]) {
    await scheduler().notify(u, { title: 'Price challenge resolved', body: `${msg}${b.note ? ` ${b.note}` : ''}`, data: { jobId: c.job_id, type: 'price_challenge.resolved' } });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- verified seller registry (Section 10 placeholder)
const SellerBody = z.object({
  name: z.string().trim().min(2).max(160),
  registrationNumber: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  userId: z.uuid().optional(),
  isVerified: z.boolean().optional(),
});

adminQualityRouter.get('/admin/sellers', async (_req, res) => {
  res.json({ sellers: await query('SELECT * FROM spare_parts_sellers ORDER BY is_verified DESC, name LIMIT 500') });
});

adminQualityRouter.post('/admin/sellers', async (req, res) => {
  const b = parse(SellerBody, req.body);
  const seller = await one(
    `INSERT INTO spare_parts_sellers (name, registration_number, phone, address, city, user_id, is_verified, verified_at, verified_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, CASE WHEN $7 THEN now() END, CASE WHEN $7 THEN $8::uuid END) RETURNING *`,
    [b.name, b.registrationNumber ?? null, b.phone ?? null, b.address ?? null, b.city ?? null, b.userId ?? null, b.isVerified ?? false, currentUser(req).id],
  );
  res.status(201).json({ seller });
});

adminQualityRouter.patch('/admin/sellers/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(SellerBody.partial(), req.body);
  const seller = await one(
    `UPDATE spare_parts_sellers SET name = COALESCE($2, name), registration_number = COALESCE($3, registration_number), phone = COALESCE($4, phone),
            address = COALESCE($5, address), city = COALESCE($6, city),
            is_verified = COALESCE($7, is_verified),
            verified_at = CASE WHEN $7 IS TRUE AND NOT is_verified THEN now() WHEN $7 IS FALSE THEN NULL ELSE verified_at END,
            verified_by = CASE WHEN $7 IS TRUE AND NOT is_verified THEN $8::uuid WHEN $7 IS FALSE THEN NULL ELSE verified_by END
      WHERE id = $1 RETURNING *`,
    [id, b.name ?? null, b.registrationNumber ?? null, b.phone ?? null, b.address ?? null, b.city ?? null, b.isVerified ?? null, currentUser(req).id],
  );
  if (!seller) throw notFound('Seller');
  res.json({ seller });
});

// ---------------------------------------------------------------- technician flags
adminQualityRouter.get('/admin/flags', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['open', 'resolved']).default('open') }), req.query);
  const flags = await query(
    `SELECT f.*, u.full_name AS technician_name FROM technician_flags f JOIN users u ON u.id = f.technician_id
      WHERE f.status = $1 ORDER BY f.created_at LIMIT 200`,
    [status],
  );
  res.json({ flags });
});

adminQualityRouter.post('/admin/flags/:id/resolve', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body);
  const flag = await one(
    `UPDATE technician_flags SET status = 'resolved', resolution_note = $2, resolved_by = $3, resolved_at = now() WHERE id = $1 AND status = 'open' RETURNING *`,
    [id, note ?? null, currentUser(req).id],
  );
  if (!flag) throw conflict('Flag not found or already resolved');
  res.json({ flag });
});

// ---------------------------------------------------------------- rating penalties
adminQualityRouter.post('/admin/technicians/:id/rating-penalties', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({ points: z.number().min(0.01).max(5), reason: z.string().trim().min(3).max(500), days: z.number().int().min(1).max(3650) }), req.body);
  const penalty = await one(
    `INSERT INTO rating_penalties (technician_id, points, reason, source, expires_at, created_by) VALUES ($1, $2, $3, 'admin', now() + make_interval(days => $4), $5) RETURNING *`,
    [id, b.points, b.reason, b.days, currentUser(req).id],
  );
  await recomputeTechnicianRating(id);
  res.status(201).json({ penalty });
});

// ---------------------------------------------------------------- labor rate adjustments (7a)
adminQualityRouter.get('/admin/rate-adjustments', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(['applied', 'held', 'admin_approved', 'admin_rejected']).default('held') }), req.query);
  const adjustments = await query(
    `SELECT a.*, u.full_name AS technician_name FROM technician_rate_adjustments a JOIN users u ON u.id = a.technician_id
      WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT 200`,
    [status],
  );
  res.json({ adjustments });
});

/** Resolve a held swing: approve applies the new tier; reject keeps the previous one. */
adminQualityRouter.post('/admin/rate-adjustments/:id/decide', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { decision, note } = parse(z.object({ decision: z.enum(['approve', 'reject']), note: z.string().trim().max(1000).optional() }), req.body);
  const admin = currentUser(req);
  const a = await tx(async (db) => {
    const a = await one(`SELECT * FROM technician_rate_adjustments WHERE id = $1 FOR UPDATE`, [id], db);
    if (!a) throw notFound('Rate adjustment');
    if (a.status !== 'held') throw conflict(`Adjustment is ${a.status}`);
    await db.query(`UPDATE technician_rate_adjustments SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1`, [
      id,
      decision === 'approve' ? 'admin_approved' : 'admin_rejected',
      admin.id,
    ]);
    const bps = decision === 'approve' ? a.new_bps : a.previous_bps;
    const stars = decision === 'approve' ? a.new_stars : a.previous_stars;
    await db.query(
      'UPDATE technician_profiles SET rate_adjustment_bps = $2, rate_tier_stars = $3, rate_held_for_review = false, rate_calculated_at = now() WHERE user_id = $1',
      [a.technician_id, bps, stars],
    );
    if (a.flag_id) {
      await db.query(`UPDATE technician_flags SET status = 'resolved', resolution_note = $2, resolved_by = $3, resolved_at = now() WHERE id = $1`, [a.flag_id, note ?? decision, admin.id]);
    }
    return a;
  });
  await scheduler().notify(a.technician_id, {
    title: 'Labor rate review complete',
    body: decision === 'approve' ? 'Your labor rate adjustment has been updated after review.' : 'After review, your previous labor rate adjustment stays in place.',
    data: { type: 'rate.reviewed' },
  });
  res.json({ ok: true });
});

/** Manually flag an applied adjustment as an anomalous swing: revert to the previous tier and hold for review. */
adminQualityRouter.post('/admin/rate-adjustments/:id/flag', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(z.object({ note: z.string().trim().max(1000).optional() }), req.body);
  await tx(async (db) => {
    const a = await one(`SELECT * FROM technician_rate_adjustments WHERE id = $1 FOR UPDATE`, [id], db);
    if (!a) throw notFound('Rate adjustment');
    if (a.status !== 'applied') throw conflict('Only applied adjustments can be flagged');
    const flag = await one(
      `INSERT INTO technician_flags (technician_id, kind, details) VALUES ($1, 'rate_swing', $2) RETURNING id`,
      [a.technician_id, JSON.stringify({ adjustmentId: id, flaggedManually: true, note: note ?? null })],
      db,
    );
    await db.query(`UPDATE technician_rate_adjustments SET status = 'held', flag_id = $2 WHERE id = $1`, [id, flag.id]);
    await db.query(
      'UPDATE technician_profiles SET rate_adjustment_bps = $2, rate_tier_stars = $3, rate_held_for_review = true WHERE user_id = $1',
      [a.technician_id, a.previous_bps, a.previous_stars],
    );
  });
  res.json({ ok: true });
});

adminQualityRouter.put('/admin/technicians/:id/rate-override', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { bps } = parse(z.object({ bps: z.number().int().min(-5000).max(5000).nullable() }), req.body);
  const row = await one('UPDATE technician_profiles SET rate_override_bps = $2 WHERE user_id = $1 RETURNING user_id, rate_override_bps', [id, bps]);
  if (!row) throw notFound('Technician');
  res.json({ technicianId: id, rateOverrideBps: row.rate_override_bps });
});

adminQualityRouter.post('/admin/technicians/:id/recalculate-rate', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  res.json({ outcome: await recalcRateAdjustment(id) });
});
