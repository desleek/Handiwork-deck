import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.ts';
import { slugify } from '../db/seedCategories.ts';
import { DEFAULT_SETTINGS, type SettingKey } from '../domain/settings.ts';
import { SETTING_SCHEMAS } from '../domain/settingsSchema.ts';
import { badRequest, conflict, notFound, parse } from '../lib/http.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { schedulePriceChallenge } from '../queue/queues.ts';
import { getJob, logJobEvent, setActionRequired, transition } from '../services/jobs.ts';
import { notify } from '../services/notifications/notify.ts';
import { captureJobPayment, refundPayment } from '../services/payments/escrow.ts';
import { addOrganicSeller } from '../services/priceChallenges.ts';
import { refreshTechnicianRating } from '../services/ratings.ts';
import { averageJobValue, bonusEconomicsReport, unfundedWarnings } from '../services/economics.ts';
import { campaignStats, markCampaignPaid, refreshCampaignStatuses } from '../services/ads.ts';
import { clickThroughRate } from '../domain/ads.ts';
import { getSettings, updateSetting } from '../services/settings.ts';
import { postLedger } from '../services/wallet.ts';

export const admin = Router();
admin.use(authenticate, requireUser('admin'));

const uuid = z.string().uuid();
const audit = (db: any, adminId: string, action: string, targetType: string, targetId: string, after: unknown, reason?: string) =>
  query(
    `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, after, reason) VALUES ($1,$2,$3,$4,$5,$6)`,
    [adminId, action, targetType, targetId, JSON.stringify(after ?? null), reason ?? null],
    db,
  );

// ---------------------------------------------------------------- settings
admin.get('/settings', async (_req, res) => res.json({ settings: await getSettings(), defaults: DEFAULT_SETTINGS }));

admin.put('/settings/:key', async (req, res) => {
  const key = req.params.key as SettingKey;
  if (!(key in DEFAULT_SETTINGS)) throw notFound('Setting');
  const b = parse(z.object({ value: z.unknown(), reason: z.string().max(500).optional() }), req.body);
  const def = DEFAULT_SETTINGS[key];
  if (typeof b.value !== typeof def || Array.isArray(b.value) !== Array.isArray(def)) {
    throw badRequest('TYPE_MISMATCH', `Setting ${key} expects a ${Array.isArray(def) ? 'list' : typeof def}`);
  }
  const schema = SETTING_SCHEMAS[key];
  if (schema) {
    const r = schema.safeParse(b.value);
    if (!r.success) throw badRequest('INVALID_SETTING', r.error.issues.map((i) => i.message).join('; '), r.error.flatten());
  }
  await tx((db) => updateSetting(key, b.value, req.user!.id, b.reason, db));
  // Section 15: bonuses must be funded by processing savings — warn (don't block) if a change breaks that.
  let warnings: string[] = [];
  if (key === 'walletBonusTiers' || key === 'gatewayFeeSchedules' || key === 'economicsAvgJobMinor') {
    const s = await getSettings();
    warnings = unfundedWarnings(s.walletBonusTiers, s, (await averageJobValue(s)).avgJobMinor);
  }
  res.json({ key, value: b.value, warnings });
});

// ---------------------------------------------------------------- categories
admin.get('/categories', async (_req, res) => res.json(await query('SELECT * FROM service_categories ORDER BY supercategory, sort_order, name')));

admin.post('/categories', async (req, res) => {
  const b = parse(z.object({ supercategory: z.enum(['household_office', 'construction']), name: z.string().trim().min(2).max(100), icon: z.string().max(60).default('wrench'), sortOrder: z.number().int().default(1000) }), req.body);
  const c = await one(
    `INSERT INTO service_categories (supercategory, name, slug, icon, sort_order) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [b.supercategory, b.name, `${b.supercategory === 'construction' ? 'c-' : ''}${slugify(b.name)}`, b.icon, b.sortOrder],
  );
  await audit(undefined, req.user!.id, 'category.create', 'category', c.id, c);
  res.status(201).json(c);
});

admin.patch('/categories/:id', async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(100).optional(), icon: z.string().max(60).optional(), isActive: z.boolean().optional(), sortOrder: z.number().int().optional(), approvalStatus: z.enum(['approved', 'rejected']).optional() }), req.body);
  const c = await one(
    `UPDATE service_categories SET name = COALESCE($2, name), icon = COALESCE($3, icon), is_active = COALESCE($4, is_active),
       sort_order = COALESCE($5, sort_order), approval_status = COALESCE($6, approval_status) WHERE id = $1 RETURNING *`,
    [parse(uuid, req.params.id), b.name ?? null, b.icon ?? null, b.isActive ?? null, b.sortOrder ?? null, b.approvalStatus ?? null],
  );
  if (!c) throw notFound('Category');
  await audit(undefined, req.user!.id, 'category.update', 'category', c.id, b);
  res.json(c);
});

// ---------------------------------------------------------------- technician verification & controls
admin.get('/technicians', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['pending', 'verified', 'rejected']).optional() }), req.query);
  res.json(
    await query(
      `SELECT u.id, u.full_name, u.email, u.phone_e164, u.status, t.verification_status, t.id_document_url, t.rating_avg, t.rating_count,
              t.performance_multiplier_bps, t.markup_cap_override_bps, t.boost_privileges_suspended, t.created_at,
              (SELECT json_agg(c.*) FROM certifications c WHERE c.technician_id = u.id) AS certifications,
              (SELECT json_agg(p.* ORDER BY p.position) FROM portfolio_images p WHERE p.technician_id = u.id) AS portfolio
         FROM technician_profiles t JOIN users u ON u.id = t.user_id
        WHERE ($1::verification_status IS NULL OR t.verification_status = $1)
        ORDER BY t.created_at DESC LIMIT 200`,
      [q.status ?? null],
    ),
  );
});

admin.post('/technicians/:id/verification', async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['verified', 'rejected']), note: z.string().max(1000).optional() }), req.body);
  const techId = parse(uuid, req.params.id);
  await tx(async (db) => {
    await query(`UPDATE technician_profiles SET verification_status = $2, updated_at = now() WHERE user_id = $1`, [techId, b.decision], db);
    await audit(db, req.user!.id, `technician.${b.decision}`, 'technician', techId, b, b.note);
  });
  await notify({ userId: techId, type: 'account.verification', title: b.decision === 'verified' ? 'You are verified' : 'Verification needs attention', body: b.decision === 'verified' ? 'You can now go online and receive bookings.' : b.note ?? 'Please update your documents.' });
  res.json({ ok: true });
});

admin.post('/certifications/:id', async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['verified', 'rejected']) }), req.body);
  await query('UPDATE certifications SET status = $2 WHERE id = $1', [parse(uuid, req.params.id), b.decision]);
  res.json({ ok: true });
});

admin.post('/portfolio/:id/moderate', async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approved', 'rejected']) }), req.body);
  await query('UPDATE portfolio_images SET moderation_status = $2 WHERE id = $1', [parse(uuid, req.params.id), b.decision]);
  res.json({ ok: true });
});

admin.post('/reviews/:id/moderate', async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['approved', 'rejected']) }), req.body);
  const r = await tx(async (db) => {
    const row = await one<any>('UPDATE technician_ratings SET moderation_status = $2 WHERE id = $1 RETURNING technician_id', [parse(uuid, req.params.id), b.decision], db);
    if (!row) throw notFound('Review');
    await refreshTechnicianRating(db, row.technician_id);
    return row;
  });
  res.json(r);
});

/** Permanent per-technician markup cap override (Section 5a) and boost privilege suspension (Section 16). */
admin.patch('/technicians/:id/controls', async (req, res) => {
  const b = parse(z.object({ markupCapOverrideBps: z.number().int().min(0).max(10_000).nullable().optional(), boostPrivilegesSuspended: z.boolean().optional(), reason: z.string().min(3).max(500) }), req.body);
  const techId = parse(uuid, req.params.id);
  await tx(async (db) => {
    if (b.markupCapOverrideBps !== undefined) await query('UPDATE technician_profiles SET markup_cap_override_bps = $2 WHERE user_id = $1', [techId, b.markupCapOverrideBps], db);
    if (b.boostPrivilegesSuspended !== undefined) await query('UPDATE technician_profiles SET boost_privileges_suspended = $2 WHERE user_id = $1', [techId, b.boostPrivilegesSuspended], db);
    await audit(db, req.user!.id, 'technician.controls', 'technician', techId, b, b.reason);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Demand Notices (5a)
admin.get('/cap-exceptions', async (req, res) => {
  const q = parse(z.object({ status: z.enum(['pending', 'approved', 'declined']).default('pending') }), req.query);
  res.json(
    await query(
      `SELECT me.*, j.short_code, u.full_name AS technician_name, qi.description, qi.unit_cost_minor, qi.quantity, qi.markup_bps
         FROM markup_exceptions me JOIN jobs j ON j.id = me.job_id JOIN users u ON u.id = me.technician_id
         JOIN quote_items qi ON qi.id = me.quote_item_id
        WHERE me.status = $1 ORDER BY me.created_at`,
      [q.status],
    ),
  );
});

admin.post('/cap-exceptions/:id/decide', async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), note: z.string().max(1000).optional(), grantPermanentBps: z.number().int().min(0).max(10_000).optional() }), req.body);
  const out = await tx(async (db) => {
    const ex = await one<any>(`SELECT * FROM markup_exceptions WHERE id = $1 AND status = 'pending' FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!ex) throw notFound('Pending exception');
    await query(
      `UPDATE markup_exceptions SET status = $2, decided_by = $3, decision_note = $4, decided_at = now(), grant_permanent_bps = $5 WHERE id = $1`,
      [ex.id, b.approve ? 'approved' : 'declined', req.user!.id, b.note ?? null, b.approve ? b.grantPermanentBps ?? null : null],
      db,
    );
    if (b.approve && b.grantPermanentBps) {
      await query('UPDATE technician_profiles SET markup_cap_override_bps = $2 WHERE user_id = $1', [ex.technician_id, b.grantPermanentBps], db);
      await audit(db, req.user!.id, 'technician.cap_override', 'technician', ex.technician_id, { bps: b.grantPermanentBps }, b.note);
    }
    await logJobEvent(db, ex.job_id, req.user!.id, b.approve ? 'cap_exception.approved' : 'cap_exception.declined', { exceptionId: ex.id, note: b.note });

    const remaining = await query<{ status: string }>('SELECT status FROM markup_exceptions WHERE quote_id = $1', [ex.quote_id], db);
    if (remaining.some((r) => r.status === 'pending')) return { ex, settled: false };
    const job = await getJob(ex.job_id, db, true);
    if (remaining.every((r) => r.status === 'approved')) {
      await query(`UPDATE quotes SET status = 'submitted' WHERE id = $1 AND status = 'pending_exception'`, [ex.quote_id], db);
      if (job.status === 'accepted') await transition(db, job, 'quoted', req.user!.id);
      else await setActionRequired(db, job.id, 'customer', 'Review the quote');
      return { ex, settled: true, approved: true, job };
    }
    await query(`UPDATE quotes SET status = 'withdrawn' WHERE id = $1`, [ex.quote_id], db);
    await setActionRequired(db, job.id, 'technician', 'Revise the quote — markup exception declined');
    return { ex, settled: true, approved: false, job };
  });
  await notify({ userId: out.ex.technician_id, type: 'cap_exception.decided', title: b.approve ? 'Cap exception approved' : 'Cap exception declined', body: b.note ?? (b.approve ? 'Your quote has been released to the customer.' : 'Please revise the markup and resubmit.'), data: { jobId: out.ex.job_id } });
  if (out.settled && out.approved) await notify({ userId: out.job!.customer_id, type: 'quote.received', title: 'Quote ready', body: `Your quote for job #${out.job!.short_code} has been reviewed and is ready.`, data: { jobId: out.job!.id } });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- price challenges (6c)
admin.get('/price-challenges', async (_req, res) => {
  res.json(
    await query(
      `SELECT pc.*, j.short_code, ps.name AS seller_name, ps.verification_status AS seller_status, qi.description, qi.unit_cost_minor,
              EXTRACT(EPOCH FROM (now() - pc.submitted_at)) / 3600 AS hours_open
         FROM price_challenges pc JOIN jobs j ON j.id = pc.job_id JOIN quote_items qi ON qi.id = pc.quote_item_id
         LEFT JOIN parts_sellers ps ON ps.id = pc.seller_id
        WHERE pc.status IN ('escalated', 'pending_evidence_review', 'open')
        ORDER BY pc.is_fast_track DESC, pc.status = 'escalated' DESC, pc.submitted_at`,
    ),
  );
});

/** Unlisted-seller evidence: case-by-case review. Accepting adds the seller as provisionally verified. */
admin.post('/price-challenges/:id/evidence', async (req, res) => {
  const b = parse(z.object({ accept: z.boolean(), note: z.string().max(1000).optional() }), req.body);
  const s = await getSettings();
  const c = await tx(async (db) => {
    const pc = await one<any>(`SELECT * FROM price_challenges WHERE id = $1 AND status = 'pending_evidence_review' FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!pc) throw notFound('Challenge awaiting evidence review');
    const job = await getJob(pc.job_id, db, true);
    if (b.accept) {
      const sellerId = await addOrganicSeller(db, pc.unlisted_seller_name);
      const r = await one<any>(`UPDATE price_challenges SET status = 'open', seller_id = $2, submitted_at = now() WHERE id = $1 RETURNING *`, [pc.id, sellerId], db);
      await setActionRequired(db, job.id, 'technician', 'Respond to price challenge');
      await logJobEvent(db, job.id, req.user!.id, 'price_challenge.evidence_accepted', { challengeId: pc.id, sellerId });
      return r;
    }
    await query(`UPDATE price_challenges SET status = 'evidence_rejected', resolved_at = now(), response_note = $2 WHERE id = $1`, [pc.id, b.note ?? null], db);
    if (job.status === 'negotiating') await transition(db, job, 'quoted', req.user!.id, { event: { kind: 'price_challenge_evidence_rejected' } });
    return null;
  });
  if (c) await schedulePriceChallenge(c.id, c.submitted_at, c.is_fast_track ? s.priceChallengeFastTrack : s.priceChallengeStandard, c.is_fast_track);
  res.json({ ok: true });
});

/** One-click WhatsApp / email nudge to the technician from the escalation queue. */
admin.post('/price-challenges/:id/nudge', async (req, res) => {
  const b = parse(z.object({ channels: z.array(z.enum(['whatsapp', 'email', 'push'])).min(1) }), req.body);
  const pc = await one<any>(`SELECT pc.*, j.short_code FROM price_challenges pc JOIN jobs j ON j.id = pc.job_id WHERE pc.id = $1`, [parse(uuid, req.params.id)]);
  if (!pc) throw notFound('Challenge');
  await notify({ userId: pc.technician_id, type: 'price_challenge.admin_nudge', title: `Action needed on job #${pc.short_code}`, body: 'Handiwork-Deck support needs your response to a price challenge.', channels: b.channels, whatsappTemplate: { name: 'price_challenge_escalated', params: [pc.short_code] }, urgent: pc.is_fast_track });
  await audit(undefined, req.user!.id, 'price_challenge.nudge', 'price_challenge', pc.id, b);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- seller registry (10)
admin.get('/sellers', async (req, res) => {
  const q = parse(z.object({ status: z.string().optional(), search: z.string().default('') }), req.query);
  res.json(await query(`SELECT * FROM parts_sellers WHERE ($1::text IS NULL OR verification_status::text = $1) AND ($2 = '' OR name ILIKE '%' || $2 || '%') ORDER BY name LIMIT 500`, [q.status ?? null, q.search]));
});

const SellerBody = z.object({
  name: z.string().trim().min(2).max(200),
  registrationNo: z.string().max(100).optional(),
  contactPhone: z.string().max(30).optional(),
  contactEmail: z.string().email().optional(),
  address: z.string().max(500).optional(),
  categoryIds: z.array(uuid).default([]),
  verificationStatus: z.enum(['provisional', 'verified', 'flagged', 'removed']).default('verified'),
});

admin.post('/sellers', async (req, res) => {
  const b = parse(SellerBody, req.body);
  const s = await one(
    `INSERT INTO parts_sellers (name, registration_no, contact_phone, contact_email, address, category_ids, verification_status, source)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'admin') RETURNING *`,
    [b.name, b.registrationNo ?? null, b.contactPhone ?? null, b.contactEmail ?? null, b.address ?? null, b.categoryIds, b.verificationStatus],
  );
  await audit(undefined, req.user!.id, 'seller.create', 'seller', s.id, s);
  res.status(201).json(s);
});

admin.patch('/sellers/:id', async (req, res) => {
  const b = parse(SellerBody.partial().extend({ reason: z.string().max(500).optional() }), req.body);
  const s = await one(
    `UPDATE parts_sellers SET name = COALESCE($2, name), registration_no = COALESCE($3, registration_no), contact_phone = COALESCE($4, contact_phone),
       contact_email = COALESCE($5, contact_email), address = COALESCE($6, address), verification_status = COALESCE($7::seller_verification, verification_status),
       updated_at = now() WHERE id = $1 RETURNING *`,
    [parse(uuid, req.params.id), b.name ?? null, b.registrationNo ?? null, b.contactPhone ?? null, b.contactEmail ?? null, b.address ?? null, b.verificationStatus ?? null],
  );
  if (!s) throw notFound('Seller');
  await audit(undefined, req.user!.id, 'seller.update', 'seller', s.id, b, b.reason);
  res.json(s);
});

/** Merge a duplicate into a canonical seller; evidence references are repointed. */
admin.post('/sellers/:id/merge', async (req, res) => {
  const b = parse(z.object({ intoId: uuid }), req.body);
  const fromId = parse(uuid, req.params.id);
  if (fromId === b.intoId) throw badRequest('SAME_SELLER', 'Cannot merge a seller into itself');
  await tx(async (db) => {
    await query('UPDATE price_challenges SET seller_id = $2 WHERE seller_id = $1', [fromId, b.intoId], db);
    await query('UPDATE quote_items SET seller_id = $2 WHERE seller_id = $1', [fromId, b.intoId], db);
    await query(
      `UPDATE parts_sellers t SET clean_approvals = t.clean_approvals + f.clean_approvals FROM parts_sellers f WHERE t.id = $2 AND f.id = $1`,
      [fromId, b.intoId],
      db,
    );
    await query(`UPDATE parts_sellers SET merged_into = $2, verification_status = 'removed' WHERE id = $1`, [fromId, b.intoId], db);
    await audit(db, req.user!.id, 'seller.merge', 'seller', fromId, b);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- Section 18 queues
admin.get('/fault-reviews', async (_req, res) => {
  res.json(
    await query(
      `SELECT f.*, j.short_code, j.status, j.action_required_reason, j.customer_id, j.technician_id,
              (SELECT json_agg(e ORDER BY e.created_at) FROM job_events e WHERE e.job_id = j.id) AS history
         FROM fault_reviews f JOIN jobs j ON j.id = f.job_id WHERE f.status = 'pending' ORDER BY f.created_at`,
    ),
  );
});

admin.post('/fault-reviews/:id', async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['customer_fault', 'technician_fault', 'no_fault']), note: z.string().max(1000).optional() }), req.body);
  await tx(async (db) => {
    const f = await one<any>(`SELECT * FROM fault_reviews WHERE id = $1 AND status = 'pending' FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!f) throw notFound('Fault review');
    const job = await getJob(f.job_id, db, true);
    await query(`UPDATE fault_reviews SET status = $2, note = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1`, [f.id, b.outcome, b.note ?? null, req.user!.id], db);
    if (!['completed', 'cancelled', 'declined', 'incomplete'].includes(job.status)) await transition(db, job, 'incomplete', req.user!.id, { event: { adminOutcome: b.outcome } });
    if (b.outcome !== 'no_fault') {
      const party = b.outcome === 'customer_fault' ? 'customer' : 'technician';
      const userId = party === 'customer' ? job.customer_id : job.technician_id;
      await query(`INSERT INTO incomplete_strikes (user_id, job_id, party, reason) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [userId, job.id, party, b.note ?? 'Admin review'], db);
      const { applyPenaltyTiers } = await import('../queue/maintenance.ts');
      await applyPenaltyTiers(db, userId, party);
    }
  });
  res.json({ ok: true });
});

admin.get('/appeals', async (_req, res) => {
  res.json(
    await query(
      `SELECT a.*, u.full_name, u.role, r.tier, r.restricted_functions, r.starts_at,
              (SELECT json_agg(s.*) FROM incomplete_strikes s WHERE s.user_id = a.user_id) AS strikes
         FROM appeals a JOIN users u ON u.id = a.user_id JOIN account_restrictions r ON r.id = a.restriction_id
        WHERE a.status = 'pending' ORDER BY a.created_at`,
    ),
  );
});

admin.post('/appeals/:id', async (req, res) => {
  const b = parse(z.object({ decision: z.enum(['upheld', 'overturned']), note: z.string().min(3).max(2000) }), req.body);
  const a = await tx(async (db) => {
    const ap = await one<any>(`SELECT * FROM appeals WHERE id = $1 AND status = 'pending' FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!ap) throw notFound('Appeal');
    await query(`UPDATE appeals SET status = $2, decision_note = $3, decided_by = $4, decided_at = now() WHERE id = $1`, [ap.id, b.decision, b.note, req.user!.id], db);
    if (b.decision === 'overturned') {
      await query(`UPDATE account_restrictions SET lifted_at = now(), lifted_by = $2 WHERE id = $1`, [ap.restriction_id, req.user!.id], db);
      await query(`UPDATE users SET status = 'active' WHERE id = $1 AND status IN ('restricted', 'suspended')`, [ap.user_id], db);
    }
    await audit(db, req.user!.id, `appeal.${b.decision}`, 'user', ap.user_id, b, b.note);
    return ap;
  });
  await notify({ userId: a.user_id, type: 'appeal.decided', title: b.decision === 'overturned' ? 'Appeal successful' : 'Appeal decision', body: b.note, channels: ['push', 'email'] });
  res.json({ ok: true });
});

admin.post('/strikes/:id/void', async (req, res) => {
  const b = parse(z.object({ reason: z.string().min(3) }), req.body);
  await query('UPDATE incomplete_strikes SET voided = true WHERE id = $1', [req.params.id]);
  await audit(undefined, req.user!.id, 'strike.void', 'strike', req.params.id, null, b.reason);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- disputes (line-item level)
admin.get('/disputes', async (_req, res) => {
  res.json(
    await query(
      `SELECT d.*, j.short_code, qi.description AS line_description, qi.line_total_minor
         FROM disputes d JOIN jobs j ON j.id = d.job_id LEFT JOIN quote_items qi ON qi.id = d.quote_item_id
        WHERE d.status = 'open' ORDER BY d.created_at`,
    ),
  );
});

admin.post('/disputes/:id/resolve', async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['resolved_customer', 'resolved_technician', 'split']), refundMinor: z.number().int().nonnegative().default(0), resolution: z.string().min(5).max(4000) }), req.body);
  await tx(async (db) => {
    const d = await one<any>(`SELECT * FROM disputes WHERE id = $1 AND status = 'open' FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!d) throw notFound('Dispute');
    const job = await getJob(d.job_id, db, true);
    const payment = await one<any>(`SELECT * FROM payments WHERE job_id = $1 AND purpose = 'job' AND status = 'held'`, [job.id], db);
    if (b.outcome === 'resolved_customer' && payment) {
      await refundPayment(db, payment.id, payment.amount_minor, `Dispute resolved in customer's favour — job #${job.short_code}`);
      await transition(db, job, 'cancelled', req.user!.id, { event: { disputeId: d.id } });
    } else if (payment) {
      // Partial refund first (line-item adjustment), then release the remainder through the normal split.
      if (b.refundMinor > 0) {
        if (b.refundMinor >= payment.amount_minor) throw badRequest('REFUND_TOO_LARGE', 'Use "resolved_customer" for a full refund');
        await refundPayment(db, payment.id, b.refundMinor, `Dispute adjustment — job #${job.short_code}`);
        await query(`UPDATE payments SET status = 'held', amount_minor = amount_minor - $2 WHERE id = $1`, [payment.id, b.refundMinor], db);
        await query(
          `UPDATE quotes SET customer_total_minor = customer_total_minor - $2, technician_net_minor = technician_net_minor - $2,
             labor_total_minor = labor_total_minor - $2 WHERE job_id = $1 AND status = 'approved'`,
          [job.id, b.refundMinor],
          db,
        );
      }
      await captureJobPayment(db, job.id, req.user!.id);
      await transition(db, job, 'completed', req.user!.id, { event: { disputeId: d.id } });
    }
    await query(`UPDATE disputes SET status = $2, resolution = $3, refund_minor = $4, resolved_by = $5, resolved_at = now() WHERE id = $1`, [d.id, b.outcome, b.resolution, b.refundMinor, req.user!.id], db);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- performance multiplier anomalies (7a)
admin.get('/multiplier-anomalies', async (_req, res) => {
  res.json(await query(`SELECT m.*, u.full_name FROM multiplier_history m JOIN users u ON u.id = m.technician_id WHERE m.review_status = 'pending' ORDER BY m.computed_at`));
});

/** Run the performance-multiplier recalculation now instead of waiting for the nightly job (Section 7a). */
admin.post('/multiplier/recalculate', async (req, res) => {
  const { recalcMultipliers } = await import('../queue/maintenance.ts');
  const r = await recalcMultipliers({ force: true });
  await audit(undefined, req.user!.id, 'multiplier.recalculate', 'system', 'all', r);
  res.json(r);
});

admin.post('/multiplier-anomalies/:id', async (req, res) => {
  const b = parse(z.object({ action: z.enum(['confirm', 'override']), overrideBps: z.number().int().min(-5000).max(5000).optional(), reason: z.string().min(3) }), req.body);
  await tx(async (db) => {
    const m = await one<any>(`SELECT * FROM multiplier_history WHERE id = $1 AND review_status = 'pending' FOR UPDATE`, [req.params.id], db);
    if (!m) throw notFound('Anomaly');
    const bps = b.action === 'confirm' ? m.to_bps : b.overrideBps ?? m.from_bps;
    await query(`UPDATE technician_profiles SET performance_multiplier_bps = $2 WHERE user_id = $1`, [m.technician_id, bps], db);
    await query(`UPDATE multiplier_history SET review_status = $2 WHERE id = $1`, [m.id, b.action === 'confirm' ? 'confirmed' : 'overridden'], db);
    await audit(db, req.user!.id, `multiplier.${b.action}`, 'technician', m.technician_id, { bps }, b.reason);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- wallet bonus extensions (15)
/** Sortable/filterable list, e.g. "frequent wallet users, 4★+, expiring in 7 days". */
admin.get('/wallet-bonus/candidates', async (req, res) => {
  const q = parse(
    z.object({
      minTopups: z.coerce.number().int().default(0),
      minCompliance: z.coerce.number().min(0).max(5).default(0),
      expiringWithinDays: z.coerce.number().int().default(30),
      sort: z.enum(['topups', 'compliance', 'expiry']).default('expiry'),
    }),
    req.query,
  );
  const s = await getSettings();
  const order = { topups: 'topups DESC', compliance: 'compliance DESC NULLS LAST', expiry: 'bonus_until ASC' }[q.sort];
  res.json(
    await query(
      `SELECT * FROM (
         SELECT u.id, u.full_name, u.completion_badge,
                GREATEST(u.created_at + make_interval(days => $4), COALESCE(u.wallet_bonus_until, '-infinity')) AS bonus_until,
                (SELECT count(*)::int FROM wallet_ledger l WHERE l.user_id = u.id AND l.type = 'topup') AS topups,
                (SELECT count(*)::int FROM wallet_ledger l WHERE l.user_id = u.id AND l.type = 'job_payment') AS wallet_payments,
                (SELECT round(avg(overall), 2) FROM customer_ratings c WHERE c.customer_id = u.id) AS compliance
           FROM users u WHERE u.role = 'customer' AND u.status = 'active') x
        WHERE topups >= $1 AND COALESCE(compliance, 0) >= $2
          AND bonus_until BETWEEN now() - interval '30 days' AND now() + make_interval(days => $3)
        ORDER BY ${order} LIMIT 500`,
      [q.minTopups, q.minCompliance, q.expiringWithinDays, s.walletBonusWindowDays],
    ),
  );
});

/** Bonus tiers modelled against gateway fee schedules, plus realised 90-day margin (Section 15). */
admin.get('/wallet-bonus/economics', async (req, res) => {
  const q = parse(
    z.object({
      provider: z.string().optional(),
      avgJobMinor: z.coerce.number().int().positive().optional(),
      channel: z.enum(['card', 'bank_transfer', 'ussd', 'virtual_account']).optional(),
    }),
    req.query,
  );
  res.json(await bonusEconomicsReport(await getSettings(), q));
});

admin.post('/wallet-bonus/extensions', async (req, res) => {
  const b = parse(z.object({ scope: z.enum(['single', 'cohort', 'global']), userIds: z.array(uuid).default([]), until: z.coerce.date(), reason: z.string().min(5).max(500) }), req.body);
  if (b.until <= new Date()) throw badRequest('PAST_DATE', 'Extension must end in the future');
  if (b.scope !== 'global' && b.userIds.length === 0) throw badRequest('NO_USERS', 'Select at least one customer');
  await tx(async (db) => {
    if (b.scope === 'global') {
      await query(`UPDATE users SET wallet_bonus_until = GREATEST(COALESCE(wallet_bonus_until, '-infinity'), $1) WHERE role = 'customer'`, [b.until], db);
      await query(`INSERT INTO wallet_bonus_extensions (scope, new_until, reason, granted_by) VALUES ('global', $1, $2, $3)`, [b.until, b.reason, req.user!.id], db);
    } else {
      await query(`UPDATE users SET wallet_bonus_until = GREATEST(COALESCE(wallet_bonus_until, '-infinity'), $2) WHERE id = ANY($1)`, [b.userIds, b.until], db);
      for (const id of b.userIds) {
        await query(`INSERT INTO wallet_bonus_extensions (user_id, scope, cohort_filter, new_until, reason, granted_by) VALUES ($1,$2,$3,$4,$5,$6)`, [id, b.scope, JSON.stringify({ size: b.userIds.length }), b.until, b.reason, req.user!.id], db);
      }
    }
  });
  res.json({ ok: true });
});

admin.post('/wallets/:userId/adjust', async (req, res) => {
  const b = parse(z.object({ amountMinor: z.number().int(), reason: z.string().min(5) }), req.body);
  await tx(async (db) => {
    await postLedger(db, { userId: parse(uuid, req.params.userId), type: 'adjustment', amountMinor: b.amountMinor, description: `Admin adjustment: ${b.reason}` });
    await audit(db, req.user!.id, 'wallet.adjust', 'user', req.params.userId, b, b.reason);
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------- moderation reports
admin.get('/reports', async (_req, res) => res.json(await query(`SELECT * FROM content_reports WHERE status = 'open' ORDER BY created_at`)));
admin.post('/reports/:id', async (req, res) => {
  const b = parse(z.object({ status: z.enum(['actioned', 'dismissed']) }), req.body);
  await query('UPDATE content_reports SET status = $2 WHERE id = $1', [req.params.id, b.status]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------- ads (12) — admin-managed to start
admin.get('/ads', async (req, res) => {
  const q = parse(z.object({ status: z.string().optional() }), req.query);
  const rows = await query<any>(
    `SELECT c.*, u.full_name AS advertiser_name, ap.company_name,
            (SELECT json_agg(cr.* ORDER BY cr.created_at DESC) FROM ad_creatives cr WHERE cr.campaign_id = c.id) AS creatives
       FROM ad_campaigns c LEFT JOIN users u ON u.id = c.advertiser_id LEFT JOIN advertiser_profiles ap ON ap.user_id = c.advertiser_id
      WHERE ($1::text IS NULL OR c.status = $1) ORDER BY c.status = 'pending_review' DESC, c.created_at DESC`,
    [q.status ?? null],
  );
  const stats = await campaignStats(rows.map((r) => r.id));
  res.json(rows.map((r) => {
    const st = stats.get(r.id) ?? { impressions: 0, clicks: 0 };
    return { ...r, ...st, ctrPct: clickThroughRate(st.impressions, st.clicks) };
  }));
});

/** Approve or reject an advertiser submission (Section 12). */
admin.post('/ads/:id/review', async (req, res) => {
  const b = parse(z.object({ approve: z.boolean(), reason: z.string().max(500).optional(), waiveFee: z.boolean().default(false) }), req.body);
  if (!b.approve && !b.reason) throw badRequest('REASON_REQUIRED', 'Give the advertiser a reason for rejection');
  const c = await tx(async (db) => {
    const camp = await one<any>(`SELECT * FROM ad_campaigns WHERE id = $1 AND status = 'pending_review' FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!camp) throw notFound('Campaign awaiting review');
    await query(
      `UPDATE ad_campaigns SET status = $2, rejection_reason = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now(),
         payment_status = CASE WHEN $5 THEN 'waived' ELSE payment_status END WHERE id = $1`,
      [camp.id, b.approve ? 'approved' : 'rejected', b.approve ? null : b.reason, req.user!.id, b.approve && b.waiveFee],
      db,
    );
    await refreshCampaignStatuses(db);
    await audit(db, req.user!.id, b.approve ? 'ad.approve' : 'ad.reject', 'ad_campaign', camp.id, b, b.reason);
    return camp;
  });
  if (c.advertiser_id) {
    await notify({
      userId: c.advertiser_id,
      type: 'ad.reviewed',
      title: b.approve ? 'Campaign approved' : 'Campaign not approved',
      body: b.approve ? (b.waiveFee ? `"${c.name}" will go live on its start date.` : `"${c.name}" is approved. Pay to schedule it.`) : b.reason!,
      channels: ['push', 'email'],
    });
  }
  res.json({ ok: true });
});

/** Record an offline (invoice / bank) payment for an admin-managed campaign. */
admin.post('/ads/:id/record-payment', async (req, res) => {
  const b = parse(z.object({ amountMinor: z.number().int().positive(), reference: z.string().min(3).max(100) }), req.body);
  await tx(async (db) => {
    const camp = await one<any>(`SELECT * FROM ad_campaigns WHERE id = $1 FOR UPDATE`, [parse(uuid, req.params.id)], db);
    if (!camp) throw notFound('Campaign');
    const p = await one<{ id: string }>(
      `INSERT INTO payments (payer_id, purpose, channel, provider, provider_ref, amount_minor, status, captured_at, metadata)
       VALUES ($1, 'ad_campaign', 'bank_transfer', 'offline', $2, $3, 'captured', now(), $4) RETURNING id`,
      [camp.advertiser_id ?? req.user!.id, `offline:${b.reference}`, b.amountMinor, JSON.stringify({ campaignId: camp.id, recordedBy: req.user!.id })],
      db,
    );
    await markCampaignPaid(db, camp.id, p!.id, b.amountMinor);
    await audit(db, req.user!.id, 'ad.record_payment', 'ad_campaign', camp.id, b);
  });
  res.json({ ok: true });
});

/** Create an advertiser account (advertisers start admin-managed). */
admin.post('/advertisers', async (req, res) => {
  const b = parse(z.object({ companyName: z.string().min(2), contactEmail: z.string().email().optional(), contactPhone: z.string().optional(), sellerId: uuid.optional() }), req.body);
  const u = await tx(async (db) => {
    const user = await one(`INSERT INTO users (role, full_name, email, phone_e164) VALUES ('advertiser', $1, $2, $3) RETURNING id, full_name`, [b.companyName, b.contactEmail ?? null, b.contactPhone ?? null], db);
    await query('INSERT INTO wallets (user_id) VALUES ($1)', [user.id], db);
    await query(`INSERT INTO advertiser_profiles (user_id, company_name, contact_email, contact_phone, seller_id) VALUES ($1,$2,$3,$4,$5)`, [user.id, b.companyName, b.contactEmail ?? null, b.contactPhone ?? null, b.sellerId ?? null], db);
    await audit(db, req.user!.id, 'advertiser.create', 'user', user.id, b);
    return user;
  });
  res.status(201).json(u);
});
admin.post('/ads', async (req, res) => {
  const b = parse(
    z.object({
      name: z.string().min(2),
      sellerId: uuid.optional(),
      placement: z.enum(['deals_featured', 'deals_brand', 'sponsored_search']),
      targetCategoryIds: z.array(uuid).default([]),
      slotPriceMinor: z.number().int().nonnegative().optional(),
      startsAt: z.coerce.date().optional(),
      endsAt: z.coerce.date().optional(),
      creative: z.object({ title: z.string().min(2).max(80), body: z.string().max(200).optional(), imageUrl: z.string().url(), clickUrl: z.string().url().optional() }),
      waiveFee: z.boolean().default(false),
    }),
    req.body,
  );
  const c = await tx(async (db) => {
    // Admin-managed campaigns are approved on creation; they go live once paid (record-payment) or waived.
    const camp = await one(
      `INSERT INTO ad_campaigns (seller_id, name, placement, target_category_ids, slot_price_minor, starts_at, ends_at, status, reviewed_by, reviewed_at,
          payment_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'approved',$8, now(), $9) RETURNING *`,
      [b.sellerId ?? null, b.name, b.placement, b.targetCategoryIds, b.slotPriceMinor ?? null, b.startsAt ?? null, b.endsAt ?? null, req.user!.id, b.waiveFee ? 'waived' : 'unpaid'],
      db,
    );
    await query(`INSERT INTO ad_creatives (campaign_id, title, body, image_url, click_url) VALUES ($1,$2,$3,$4,$5)`, [camp.id, b.creative.title, b.creative.body ?? null, b.creative.imageUrl, b.creative.clickUrl ?? null], db);
    await refreshCampaignStatuses(db);
    return camp;
  });
  res.status(201).json(c);
});
/** Pause / resume / end a campaign. Resuming goes back through the normal paid + in-window check. */
admin.patch('/ads/:id', async (req, res) => {
  const b = parse(z.object({ status: z.enum(['paused', 'approved', 'ended']), reason: z.string().max(500).optional() }), req.body);
  const c = await tx(async (db) => {
    const r = await one('UPDATE ad_campaigns SET status = $2, updated_at = now() WHERE id = $1 RETURNING *', [parse(uuid, req.params.id), b.status], db);
    if (!r) throw notFound('Campaign');
    await refreshCampaignStatuses(db);
    await audit(db, req.user!.id, `ad.${b.status}`, 'ad_campaign', r.id, b, b.reason);
    return r;
  });
  res.json(c);
});

// ---------------------------------------------------------------- live boost monitoring (16)
admin.get('/boosts', async (_req, res) => {
  res.json({
    active: await query(
      `SELECT b.*, u.full_name, c.name AS category FROM boosts b JOIN users u ON u.id = b.technician_id JOIN service_categories c ON c.id = b.category_id
        WHERE b.status IN ('scheduled', 'active') ORDER BY b.starts_at`,
    ),
    alertsToday: await query(`SELECT a.*, u.full_name FROM push_alert_sends a JOIN users u ON u.id = a.technician_id WHERE a.created_at > now() - interval '24 hours' ORDER BY a.created_at DESC`),
  });
});

// ---------------------------------------------------------------- analytics (19)
admin.get('/analytics', async (req, res) => {
  const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
  const p = [q.days];
  const [gmvByChannel, revenue, categoryDemand, rates, wallet, withdrawals, traction, ads] = await Promise.all([
    query(`SELECT channel, provider, count(*)::int AS payments, sum(amount_minor)::bigint AS gmv_minor FROM payments
            WHERE purpose = 'job' AND status IN ('held', 'captured') AND created_at > now() - make_interval(days => $1) GROUP BY 1, 2 ORDER BY 4 DESC`, p),
    one(`SELECT
           COALESCE(sum(amount_minor) FILTER (WHERE component = 'labor_commission'), 0)::bigint AS labor_commission_minor,
           COALESCE(sum(amount_minor) FILTER (WHERE component = 'markup_commission'), 0)::bigint AS markup_commission_minor,
           COALESCE(sum(amount_minor) FILTER (WHERE component = 'boost'), 0)::bigint AS boost_revenue_minor,
           COALESCE(sum(amount_minor) FILTER (WHERE component = 'push_alert'), 0)::bigint AS push_alert_revenue_minor,
           COALESCE(sum(amount_minor) FILTER (WHERE component = 'ad'), 0)::bigint AS ad_revenue_minor
         FROM payment_splits WHERE recipient = 'platform' AND created_at > now() - make_interval(days => $1)`, p),
    query(`SELECT c.name, count(*)::int AS jobs FROM jobs j JOIN service_categories c ON c.id = j.category_id
            WHERE j.created_at > now() - make_interval(days => $1) GROUP BY 1 ORDER BY 2 DESC LIMIT 25`, p),
    one(`SELECT
           (SELECT count(*) FROM quote_items qi JOIN quotes q ON q.id = qi.quote_id WHERE qi.kind = 'part' AND qi.markup_bps > 0 AND q.created_at > now() - make_interval(days => $1))::int AS marked_up_lines,
           (SELECT count(*) FROM markup_exceptions WHERE created_at > now() - make_interval(days => $1))::int AS cap_exceptions,
           (SELECT count(*) FROM price_challenges WHERE submitted_at > now() - make_interval(days => $1))::int AS price_challenges,
           (SELECT count(*) FROM disputes WHERE created_at > now() - make_interval(days => $1))::int AS disputes,
           (SELECT count(*) FROM jobs WHERE status = 'completed' AND completed_at > now() - make_interval(days => $1))::int AS completed_jobs,
           (SELECT count(*) FROM technician_ratings WHERE created_at > now() - make_interval(days => $1))::int AS reviews`, p),
    one(`SELECT COALESCE(sum(amount_minor) FILTER (WHERE type = 'topup'), 0)::bigint AS topups_minor,
                COALESCE(sum(amount_minor) FILTER (WHERE type = 'topup_bonus'), 0)::bigint AS bonuses_minor
           FROM wallet_ledger WHERE created_at > now() - make_interval(days => $1)`, p),
    one(`SELECT count(*) FILTER (WHERE speed = 'instant')::int AS instant, count(*) FILTER (WHERE speed = 'standard')::int AS standard,
                COALESCE(sum(amount_minor), 0)::bigint AS volume_minor, COALESCE(sum(fee_minor), 0)::bigint AS fees_minor
           FROM withdrawals WHERE created_at > now() - make_interval(days => $1)`, p),
    // Section 13 traction milestones (greenlight signal for the Supplies marketplace)
    one(`SELECT (SELECT count(DISTINCT customer_id) FROM jobs WHERE created_at > now() - interval '30 days')::int AS monthly_active_customers,
                (SELECT count(*) FROM jobs WHERE status = 'completed' AND completed_at > now() - interval '30 days')::int AS completed_jobs_30d,
                (SELECT count(*) FROM parts_sellers WHERE verification_status = 'verified')::int AS verified_sellers,
                (SELECT count(*) FROM supplies_waitlist)::int AS supplies_waitlist`),
    one(`SELECT count(*) FILTER (WHERE type = 'impression')::int AS impressions, count(*) FILTER (WHERE type = 'click')::int AS clicks,
                (SELECT count(*) FROM ad_campaigns WHERE status = 'active')::int AS active_campaigns
           FROM ad_events WHERE created_at > now() - make_interval(days => $1)`, p),
  ]);
  res.json({ days: q.days, gmvByChannel, revenue, categoryDemand, rates, wallet, withdrawals, traction, ads: { ...ads, ctrPct: clickThroughRate(ads.impressions, ads.clicks) } });
});

admin.get('/jobs/:id', async (req, res) => {
  const job = await getJob(parse(uuid, req.params.id));
  const events = await query('SELECT * FROM job_events WHERE job_id = $1 ORDER BY created_at', [job.id]);
  res.json({ job, events });
});

admin.post('/jobs/:id/force-status', async (req, res) => {
  const b = parse(z.object({ status: z.string(), reason: z.string().min(5) }), req.body);
  await tx(async (db) => {
    const job = await getJob(parse(uuid, req.params.id), db, true);
    if (job.status === b.status) throw conflict('SAME_STATUS', 'Job is already in that status');
    await transition(db, job, b.status, req.user!.id, { event: { admin: true, reason: b.reason } });
    await audit(db, req.user!.id, 'job.force_status', 'job', job.id, b, b.reason);
  });
  res.json({ ok: true });
});
