import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs as scheduler } from '../queues/index';
import { audit } from '../services/audit';
import { applyChallengedPrices, notifyTechnicianOfChallenge, scheduleChallenge, timelineFor } from '../services/priceChallenges';
import { promoteEvidenceSellers, recordCleanApproval } from '../services/sellers';
import { recalcRateAdjustment } from '../services/rateAdjustment';
import { recomputeTechnicianRating } from '../services/ratings';

/** Admin tools for Sections 6 & 7: price challenges, seller registry, flags, rate adjustments, penalties. */
export const adminQualityRouter = Router();
adminQualityRouter.use('/admin', authenticate, requireUser('admin'));

// ---------------------------------------------------------------- price challenges (6c)
adminQualityRouter.get('/admin/price-challenges', async (req, res) => {
  // "open" = awaiting evidence review or the technician.
  const { status } = parse(z.object({ status: z.string().default('open') }), req.query);
  const challenges = await query(
    `SELECT pc.*, j.ref AS job_ref, j.title AS job_title, t.full_name AS technician_name, c.full_name AS customer_name,
            (SELECT json_agg(l) FROM price_challenge_lines l WHERE l.challenge_id = pc.id) AS lines,
            (SELECT json_agg(json_build_object('id', f.id, 'url', f.url, 'seller', s.name, 'sellerStatus', s.status))
               FROM files f JOIN spare_parts_sellers s ON s.id = f.seller_id WHERE f.id = ANY(pc.evidence_file_ids)) AS evidence
       FROM price_challenges pc JOIN jobs j ON j.id = pc.job_id JOIN users t ON t.id = pc.technician_id JOIN users c ON c.id = pc.customer_id
      WHERE ($1 = 'open' AND pc.status IN ('pending', 'pending_review')) OR pc.status::text = $1
      -- Fast Track first, then evidence reviews, then escalated, then oldest.
      ORDER BY pc.fast_track DESC, (pc.status = 'pending_review') DESC, (pc.escalated_at IS NOT NULL) DESC, pc.created_at LIMIT 200`,
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
    if (b.decision === 'approve_customer') {
      await applyChallengedPrices(db, id);
      await recordCleanApproval(db, c.evidence_file_ids);
    }
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

/**
 * Section 10: evidence citing a seller not yet in the registry is reviewed case by case.
 * Accepting it adds those sellers as provisionally verified and starts the normal timeline;
 * rejecting it closes the challenge (the seller can be flagged separately).
 */
adminQualityRouter.post('/admin/price-challenges/:id/review-evidence', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({ decision: z.enum(['accept', 'reject']), note: z.string().trim().max(1000).optional() }), req.body);
  const admin = currentUser(req);
  const c = await tx(async (db) => {
    const c = await one(`SELECT * FROM price_challenges WHERE id = $1 FOR UPDATE`, [id], db);
    if (!c) throw notFound('Price challenge');
    if (c.status !== 'pending_review') throw conflict('This challenge is not awaiting evidence review');
    if (b.decision === 'accept') {
      await promoteEvidenceSellers(db, c.evidence_file_ids);
      const t = await timelineFor(c.fast_track);
      // The response clock starts now that the evidence is accepted.
      await db.query(
        `UPDATE price_challenges SET status = 'pending', evidence_review_note = $2,
                response_due_at = now() + make_interval(secs => $3), final_action_at = now() + make_interval(secs => $4)
          WHERE id = $1`,
        [id, b.note ?? null, t.responseDueHours * 3600, t.finalActionHours * 3600],
      );
    } else {
      await db.query(`UPDATE price_challenges SET status = 'evidence_rejected', evidence_review_note = $2, resolved_at = now(), resolved_by = $3 WHERE id = $1`, [
        id,
        b.note ?? null,
        admin.id,
      ]);
      await db.query(`UPDATE quotes SET status = 'pending' WHERE id = $1 AND status = 'countered'`, [c.quote_id]);
    }
    await audit(c.job_id, admin.id, `price_challenge.evidence_${b.decision === 'accept' ? 'accepted' : 'rejected'}`, { challengeId: id, note: b.note ?? null }, db);
    return c;
  });
  if (b.decision === 'accept') {
    await scheduleChallenge(id, c.fast_track);
    await notifyTechnicianOfChallenge(id);
  } else {
    await scheduler().notify(c.customer_id, {
      title: 'Price evidence not accepted',
      body: `We couldn't accept the price evidence for your challenge.${b.note ? ` ${b.note}` : ''}`,
      data: { jobId: c.job_id, type: 'price_challenge.evidence_rejected' },
    });
  }
  res.json({ ok: true });
});

// ---------------------------------------------------------------- seller registry (Section 10)
const SellerBody = z.object({
  name: z.string().trim().min(2).max(160),
  registrationNumber: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(30).optional(),
  email: z.email().optional(),
  address: z.string().trim().max(300).optional(),
  city: z.string().trim().max(80).optional(),
  categoryIds: z.array(z.number().int().positive()).max(50).optional(),
  userId: z.uuid().optional(),
});

adminQualityRouter.get('/admin/sellers', async (req, res) => {
  const { status, q } = parse(
    z.object({ status: z.enum(['unlisted', 'provisional', 'verified', 'flagged', 'removed', 'merged']).optional(), q: z.string().trim().max(80).optional() }),
    req.query,
  );
  const sellers = await query(
    `SELECT s.*, (SELECT count(*) FROM files f WHERE f.seller_id = s.id)::int AS evidence_count
       FROM spare_parts_sellers s
      WHERE ($1::seller_status IS NULL OR s.status = $1) AND ($2::text IS NULL OR s.name ILIKE '%' || $2 || '%')
      ORDER BY array_position(ARRAY['unlisted','provisional','verified','flagged','removed','merged']::seller_status[], s.status), s.name LIMIT 500`,
    [status ?? null, q ?? null],
  );
  res.json({ sellers });
});

/** Admin-added sellers seed the registry as fully verified. */
adminQualityRouter.post('/admin/sellers', async (req, res) => {
  const b = parse(SellerBody.extend({ status: z.enum(['provisional', 'verified']).default('verified') }), req.body);
  const seller = await one(
    `INSERT INTO spare_parts_sellers (name, registration_number, phone, email, address, city, category_ids, user_id, status, verified_at, verified_by, created_via, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::seller_status, CASE WHEN $9::text = 'verified' THEN now() END, CASE WHEN $9::text = 'verified' THEN $10::uuid END, 'admin', $10) RETURNING *`,
    [b.name, b.registrationNumber ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.city ?? null, b.categoryIds ?? [], b.userId ?? null, b.status, currentUser(req).id],
  );
  res.status(201).json({ seller });
});

adminQualityRouter.patch('/admin/sellers/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(SellerBody.partial(), req.body);
  const seller = await one(
    `UPDATE spare_parts_sellers SET name = COALESCE($2, name), registration_number = COALESCE($3, registration_number), phone = COALESCE($4, phone),
            email = COALESCE($5, email), address = COALESCE($6, address), city = COALESCE($7, city), category_ids = COALESCE($8, category_ids)
      WHERE id = $1 AND status <> 'merged' RETURNING *`,
    [id, b.name ?? null, b.registrationNumber ?? null, b.phone ?? null, b.email ?? null, b.address ?? null, b.city ?? null, b.categoryIds ?? null],
  );
  if (!seller) throw notFound('Seller');
  res.json({ seller });
});

/**
 * Trust transitions: provisional/unlisted → verified (upgrade), any → provisional,
 * flag (suspected fraud: evidence refused), remove, or reinstate a flagged seller.
 */
adminQualityRouter.post('/admin/sellers/:id/status', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(z.object({ status: z.enum(['provisional', 'verified', 'flagged', 'removed']), reason: z.string().trim().max(500).optional() }), req.body);
  if ((b.status === 'flagged' || b.status === 'removed') && !b.reason) throw badRequest('Give a reason for flagging or removing a seller');
  const seller = await one(
    `UPDATE spare_parts_sellers SET status = $2::seller_status,
            flag_reason = CASE WHEN $2::text IN ('flagged', 'removed') THEN $3 ELSE NULL END,
            verified_at = CASE WHEN $2::text = 'verified' THEN now() ELSE verified_at END,
            verified_by = CASE WHEN $2::text = 'verified' THEN $4::uuid ELSE verified_by END
      WHERE id = $1 AND status <> 'merged' RETURNING *`,
    [id, b.status, b.reason ?? null, currentUser(req).id],
  );
  if (!seller) throw notFound('Seller');
  res.json({ seller });
});

/** Merge a duplicate into the surviving record: evidence and approval counts move over. */
adminQualityRouter.post('/admin/sellers/:id/merge', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { intoId } = parse(z.object({ intoId: z.uuid() }), req.body);
  if (id === intoId) throw badRequest('Cannot merge a seller into itself');
  const seller = await tx(async (db) => {
    const [dup, keep] = await Promise.all([
      one(`SELECT * FROM spare_parts_sellers WHERE id = $1 FOR UPDATE`, [id], db),
      one(`SELECT * FROM spare_parts_sellers WHERE id = $1 FOR UPDATE`, [intoId], db),
    ]);
    if (!dup || !keep) throw notFound('Seller');
    if (dup.status === 'merged' || keep.status === 'merged') throw conflict('Seller was already merged');
    await db.query('UPDATE files SET seller_id = $2 WHERE seller_id = $1', [id, intoId]);
    // The surviving record keeps the more trusted status and fills gaps from the duplicate.
    const rank = ['removed', 'flagged', 'unlisted', 'provisional', 'verified'];
    const status = rank.indexOf(dup.status) > rank.indexOf(keep.status) && !['flagged', 'removed'].includes(keep.status) ? dup.status : keep.status;
    const merged = await one(
      `UPDATE spare_parts_sellers SET clean_approvals = clean_approvals + $2, status = $3,
              phone = COALESCE(phone, $4), email = COALESCE(email, $5), address = COALESCE(address, $6), city = COALESCE(city, $7),
              registration_number = COALESCE(registration_number, $8),
              category_ids = ARRAY(SELECT DISTINCT unnest(category_ids || $9::int[]))
        WHERE id = $1 RETURNING *`,
      [intoId, dup.clean_approvals, status, dup.phone, dup.email, dup.address, dup.city, dup.registration_number, dup.category_ids],
      db,
    );
    await db.query(`UPDATE spare_parts_sellers SET status = 'merged', merged_into = $2 WHERE id = $1`, [id, intoId]);
    return merged;
  });
  res.json({ seller });
});

// ---------------------------------------------------------------- Section 8: full chat log for disputes
/** Every thread on a job with the unmasked original text of each message (admin-only dispute evidence). */
adminQualityRouter.get('/admin/jobs/:id/messages', async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const threads = await query(
    `SELECT c.id, c.technician_id, t.full_name AS technician_name, c.customer_id, cu.full_name AS customer_name, c.is_open,
            (SELECT coalesce(json_agg(m ORDER BY m.created_at), '[]'::json) FROM (
               SELECT m.id, m.sender_id, u.role AS sender_role, m.body, m.original_body, m.masked, m.channel, m.created_at
                 FROM messages m LEFT JOIN users u ON u.id = m.sender_id WHERE m.conversation_id = c.id) m) AS messages
       FROM conversations c JOIN users t ON t.id = c.technician_id JOIN users cu ON cu.id = c.customer_id
      WHERE c.job_id = $1 ORDER BY c.created_at`,
    [jobId],
  );
  res.json({ threads });
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
