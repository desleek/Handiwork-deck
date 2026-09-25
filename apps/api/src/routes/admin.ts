import { VERIFICATION_STATUSES } from '@handiwork/shared';
import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { postToWallet } from '../services/wallet';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { jobs } from '../queues/index';
import { getProvider, type ProviderName } from '../services/payments/index';

export const adminRouter = Router();
adminRouter.use('/admin', authenticate, requireUser('admin'));

adminRouter.get('/admin/stats', async (_req, res) => {
  const stats = await one(`SELECT
      (SELECT count(*) FROM users WHERE role = 'customer') AS customers,
      (SELECT count(*) FROM users WHERE role = 'technician') AS technicians,
      (SELECT count(*) FROM technician_profiles WHERE verification_status = 'pending') AS pending_verifications,
      (SELECT count(*) FROM jobs WHERE status IN ('open', 'quoted')) AS open_jobs,
      (SELECT count(*) FROM jobs WHERE status IN ('assigned', 'en_route', 'in_progress')) AS active_jobs,
      (SELECT count(*) FROM escalations WHERE resolved_at IS NULL) AS open_escalations,
      (SELECT coalesce(sum(platform_fee_minor), 0) FROM payments WHERE status = 'succeeded') AS platform_fees_minor`);
  res.json({ stats });
});

adminRouter.get('/admin/technicians', async (req, res) => {
  const { status } = parse(z.object({ status: z.enum(VERIFICATION_STATUSES).default('pending') }), req.query);
  const technicians = await query(
    `SELECT u.id, u.full_name, u.phone_e164, u.email, u.created_at, tp.verification_status, tp.years_experience,
            array(SELECT f.id FROM files f WHERE f.owner_id = u.id AND f.kind = 'id_document') AS id_document_ids
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
      WHERE tp.verification_status = $1 ORDER BY u.created_at LIMIT 200`,
    [status],
  );
  res.json({ technicians });
});

adminRouter.post('/admin/technicians/:id/verification', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { status } = parse(z.object({ status: z.enum(VERIFICATION_STATUSES) }), req.body);
  const row = await one('UPDATE technician_profiles SET verification_status = $2 WHERE user_id = $1 RETURNING user_id, verification_status', [id, status]);
  if (!row) throw notFound('Technician');
  const copy: Record<string, string> = {
    verified: 'You are verified and can now quote on jobs.',
    rejected: 'Your verification was not approved. Please check your documents.',
    suspended: 'Your account has been suspended. Contact support.',
    pending: 'Your verification is being reviewed.',
  };
  await jobs().notify(id, { title: 'Verification update', body: copy[status]!, data: { type: 'verification' } });
  res.json({ technician: row });
});

adminRouter.post('/admin/users/:id/active', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { isActive } = parse(z.object({ isActive: z.boolean() }), req.body);
  const user = await one('UPDATE users SET is_active = $2 WHERE id = $1 RETURNING id, is_active', [id, isActive]);
  if (!user) throw notFound('User');
  res.json({ user });
});

adminRouter.get('/admin/escalations', async (_req, res) => {
  const escalations = await query(
    `SELECT e.*, j.ref, j.title, j.status AS job_status FROM escalations e JOIN jobs j ON j.id = e.job_id
      WHERE e.resolved_at IS NULL ORDER BY e.level DESC, e.created_at LIMIT 200`,
  );
  res.json({ escalations });
});

adminRouter.post('/admin/escalations/:id/resolve', async (req, res) => {
  const id = parse(z.coerce.number().int().positive(), req.params.id);
  const row = await one('UPDATE escalations SET resolved_at = now(), resolved_by = $2 WHERE id = $1 AND resolved_at IS NULL RETURNING *', [
    id,
    currentUser(req).id,
  ]);
  if (!row) throw notFound('Open escalation');
  res.json({ escalation: row });
});

adminRouter.get('/admin/ads', async (req, res) => {
  const { status } = parse(z.object({ status: z.string().default('pending_review') }), req.query);
  const ads = await query('SELECT * FROM ad_campaigns WHERE status = $1::ad_status ORDER BY created_at LIMIT 200', [status]);
  res.json({ ads });
});

adminRouter.post('/admin/ads/:id/review', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { decision } = parse(z.object({ decision: z.enum(['approve', 'reject']) }), req.body);
  const ad = await one(
    `UPDATE ad_campaigns SET status = $2 WHERE id = $1 AND status = 'pending_review' RETURNING *`,
    [id, decision === 'approve' ? 'active' : 'rejected'],
  );
  if (!ad) throw conflict('Campaign is not awaiting review');
  res.json({ ad });
});

/**
 * Refunds a captured payment.
 *  - wallet settlement: reversed internally (technician's share and our fee back to the customer's wallet).
 *  - platform_collect: the technician's wallet credit is clawed back first, then the gateway refunds.
 *  - split: the gateway reverses the split (Stripe reverse_transfer / provider refund).
 */
adminRouter.post('/admin/payments/:id/refund', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { amountMinor } = parse(z.object({ amountMinor: z.number().int().positive().optional() }), req.body);
  const payment = await one(`SELECT * FROM payments WHERE id = $1`, [id]);
  if (!payment) throw notFound('Payment');
  if (!['succeeded', 'partially_refunded'].includes(payment.status)) throw conflict('Only captured payments can be refunded');
  const refundable = Number(payment.amount_minor) - Number(payment.refunded_minor);
  const amount = amountMinor ?? refundable;
  if (amount > refundable) throw conflict(`At most ${refundable} can be refunded`);
  const gross = Number(payment.amount_minor);
  const payeeShare = Math.round(((gross - Number(payment.platform_fee_minor)) * amount) / gross);
  const refundKey = `${payment.id}:${Number(payment.refunded_minor) + amount}`;

  if (payment.purpose === 'job' && payment.settlement !== 'split') {
    await tx(async (db) => {
      // Ledger idempotency keys on payment_id, so refund entries (which can repeat for partial refunds) carry a memo instead.
      if (payeeShare > 0) {
        await postToWallet(db, { userId: payment.payee_id, currency: payment.currency, amountMinor: -payeeShare, kind: 'refund', jobId: payment.job_id, memo: `Refund ${refundKey}` });
      }
      if (payment.settlement === 'wallet') {
        await postToWallet(db, { userId: payment.payer_id, currency: payment.currency, amountMinor: amount, kind: 'refund', jobId: payment.job_id, memo: `Refund ${refundKey}` });
        const refunded = Number(payment.refunded_minor) + amount;
        await db.query('UPDATE payments SET refunded_minor = $2, status = $3 WHERE id = $1', [id, refunded, refunded >= gross ? 'refunded' : 'partially_refunded']);
      }
    });
    if (payment.settlement === 'wallet') {
      res.status(200).json({ refundRef: `wallet:${refundKey}`, status: 'refunded_to_wallet' });
      return;
    }
  }
  // The provider's refund webhook updates refunded_minor / status.
  const result = await getProvider(payment.provider as ProviderName).refund({
    providerRef: payment.provider_ref,
    amount: amountMinor,
    currency: payment.currency,
  });
  res.status(202).json({ refundRef: result.refundRef });
});
