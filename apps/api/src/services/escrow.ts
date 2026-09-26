import type pg from 'pg';
import { one, query, tx } from '../db/pool';
import { conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { jobs } from '../queues/index';
import { audit } from './audit';
import { invoiceFor } from './jobs/invoice';
import { afterTransition, type JobRecord, transitionJob } from './jobs/lifecycle';
import { getProvider, type ProviderName } from './payments/index';
import { getSetting } from './settings';
import { postToWallet } from './wallet';

/**
 * Section 11: every payment channel (card, bank transfer / virtual account, USSD,
 * wallet) feeds one flow:
 *
 *   escrow hold  ->  itemized capture  ->  split payout
 *
 * The customer funds the accepted quote into escrow before work starts. When the
 * job is done the customer confirms (or it auto-releases after `escrow.autoReleaseHours`),
 * and the invoice is captured line by line: labor, parts at base cost, disclosed
 * markup, commission on labor + markup only. The technician's share lands in their
 * wallet (then Section 4 payouts), any excess goes back to the customer.
 */

export interface GatewayRefund {
  paymentId: string;
  provider: ProviderName;
  providerRef: string;
  currency: string;
  amount: number;
}

/** Returns money from an escrow payment: wallet-funded goes straight back to the wallet; gateways refund after commit. */
async function refundPayment(db: pg.PoolClient, payment: Record<string, any>, amount: number): Promise<GatewayRefund | null> {
  if (amount <= 0) return null;
  if (payment.provider === 'wallet') {
    await postToWallet(db, { userId: payment.payer_id, currency: payment.currency, amountMinor: amount, kind: 'refund', paymentId: payment.id, jobId: payment.job_id, memo: 'Escrow refund' });
    const refunded = Number(payment.refunded_minor) + amount;
    await db.query('UPDATE payments SET refunded_minor = $2, status = $3 WHERE id = $1', [
      payment.id,
      refunded,
      refunded >= Number(payment.amount_minor) ? 'refunded' : 'partially_refunded',
    ]);
    return null;
  }
  return { paymentId: payment.id, provider: payment.provider, providerRef: payment.provider_ref, currency: payment.currency, amount };
}

/** Provider refunds run outside the transaction; the refund webhook updates the payment row. */
export async function runGatewayRefunds(refunds: (GatewayRefund | null)[]) {
  for (const r of refunds) {
    if (!r) continue;
    try {
      await getProvider(r.provider).refund({ providerRef: r.providerRef, amount: r.amount, currency: r.currency });
    } catch (err) {
      logger.error({ err, paymentId: r.paymentId }, 'escrow refund failed; needs manual action');
    }
  }
}

export type FundOutcome = { outcome: 'held' | 'captured' | 'refund_orphan'; job: JobRecord | null; refunds: (GatewayRefund | null)[]; fundedJobId?: string };

/**
 * A job payment succeeded: hold it in escrow. If the job is already completed
 * (the customer paid after the work), paying counts as confirming, so it is
 * captured straight away. A payment for a job that can no longer be funded
 * (cancelled, or already funded by another channel) is refunded.
 */
export async function fundEscrow(db: pg.PoolClient, payment: Record<string, any>): Promise<FundOutcome> {
  const job = await one('SELECT * FROM jobs WHERE id = $1 FOR UPDATE', [payment.job_id], db);
  if (!job) throw notFound('Job');
  if (job.escrow_status !== 'unfunded' || ['cancelled', 'open', 'quoted'].includes(job.status)) {
    await audit(job.id, null, 'escrow.orphan_payment_refunded', { paymentId: payment.id }, db);
    return { outcome: 'refund_orphan', job: null, refunds: [await refundPayment(db, payment, Number(payment.amount_minor))] };
  }
  await db.query('INSERT INTO escrow_holds (job_id, payment_id, currency, held_minor) VALUES ($1, $2, $3, $4)', [
    job.id,
    payment.id,
    payment.currency,
    payment.amount_minor,
  ]);
  await db.query(`UPDATE jobs SET escrow_status = 'held' WHERE id = $1`, [job.id]);
  await audit(job.id, payment.payer_id, 'escrow.funded', { paymentId: payment.id, amountMinor: Number(payment.amount_minor), provider: payment.provider }, db);
  if (job.status === 'completed') {
    const captured = await captureEscrow(db, job.id, 'customer');
    return { outcome: 'captured', job: captured.job, refunds: captured.refunds };
  }
  return { outcome: 'held', job: null, refunds: [], fundedJobId: job.id };
}

export async function notifyFunded(jobId: string) {
  const job = await one('SELECT ref, technician_id FROM jobs WHERE id = $1', [jobId]);
  if (job?.technician_id) {
    await jobs().notify(job.technician_id, {
      title: 'Payment secured',
      body: `The customer's payment for #${job.ref} is held in escrow. You're clear to start.`,
      data: { jobId, type: 'escrow.funded' },
      whatsapp: true,
    });
  }
}

/**
 * Itemized capture. By default the invoice total (capped at what is held); an
 * admin settling a dispute can capture less. Commission is on labor and markup
 * only, pro-rated when less than the full invoice is captured.
 */
export async function captureEscrow(
  db: pg.PoolClient,
  jobId: string,
  releasedBy: 'customer' | 'auto' | 'admin',
  opts: { captureMinor?: number; actorId?: string | null } = {},
): Promise<{ job: JobRecord | null; refunds: (GatewayRefund | null)[]; capturedMinor: number }> {
  const hold = await one(`SELECT * FROM escrow_holds WHERE job_id = $1 AND status = 'held' FOR UPDATE`, [jobId], db);
  if (!hold) throw conflict('No funds are held in escrow for this job');
  const payment = await one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [hold.payment_id], db);
  const held = Number(hold.held_minor);
  const inv = await invoiceFor(jobId, db);
  const full = Math.min(inv.totals.total, held);
  const amount = opts.captureMinor ?? full;
  if (amount < 0 || amount > held) throw conflict(`Capture must be between 0 and ${held}`);

  const share = inv.totals.total > 0 ? amount / inv.totals.total : 0;
  const scale = (n: number) => Math.round(n * Math.min(share, 1));
  const commission = amount === inv.totals.total ? inv.commission.platformFee : scale(inv.commission.platformFee);
  const payout = amount - commission;

  if (payout > 0) {
    await postToWallet(db, { userId: payment.payee_id, currency: hold.currency, amountMinor: payout, kind: 'job_earning', paymentId: payment.id, jobId, memo: 'Escrow release' });
  }
  const refund = await refundPayment(db, payment, held - amount);
  await db.query('UPDATE payments SET platform_fee_minor = $2 WHERE id = $1', [payment.id, commission]);
  await db.query(
    `UPDATE escrow_holds SET status = 'captured', captured_minor = $2, labor_minor = $3, parts_base_minor = $4, markup_minor = $5,
            commission_minor = $6, technician_payout_minor = $7, refunded_minor = $8, released_by = $9, captured_at = now()
      WHERE job_id = $1`,
    [jobId, amount, scale(inv.totals.labor), scale(inv.totals.partsBase), scale(inv.totals.markup), commission, payout, held - amount, releasedBy],
  );
  await db.query(`UPDATE jobs SET escrow_status = 'captured' WHERE id = $1`, [jobId]);
  await audit(jobId, opts.actorId ?? null, 'escrow.captured', { releasedBy, capturedMinor: amount, commissionMinor: commission, technicianPayoutMinor: payout, refundedMinor: held - amount }, db);

  const status = (await one('SELECT status FROM jobs WHERE id = $1', [jobId], db))!.status;
  let job: JobRecord | null = null;
  if (status === 'completed') job = await transitionJob(jobId, 'paid', { id: null, role: 'system' }, { db, note: `escrow released (${releasedBy})` });
  else if (status === 'disputed') job = await transitionJob(jobId, 'paid', { id: opts.actorId ?? null, role: 'admin' }, { db, note: 'dispute settled from escrow' });
  if (job) await db.query('UPDATE conversations SET is_open = false WHERE job_id = $1', [jobId]);
  return { job, refunds: [refund], capturedMinor: amount };
}

/** Returns everything held (cancellation, declined booking, dispute settled in the customer's favour). */
export async function refundEscrow(db: pg.PoolClient, jobId: string, reason: string, actorId: string | null = null): Promise<(GatewayRefund | null)[]> {
  const hold = await one(`SELECT * FROM escrow_holds WHERE job_id = $1 AND status = 'held' FOR UPDATE`, [jobId], db);
  if (!hold) return [];
  const payment = await one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [hold.payment_id], db);
  const refund = await refundPayment(db, payment, Number(hold.held_minor));
  await db.query(`UPDATE escrow_holds SET status = 'refunded', refunded_minor = held_minor, refunded_at = now() WHERE job_id = $1`, [jobId]);
  await db.query(`UPDATE jobs SET escrow_status = 'refunded' WHERE id = $1`, [jobId]);
  await audit(jobId, actorId, 'escrow.refunded', { reason, amountMinor: Number(hold.held_minor) }, db);
  return [refund];
}

/**
 * A job left the path to completion (cancelled, or an instant booking declined
 * back to the marketplace): return any escrow. Declined bookings go back to
 * 'unfunded' so the customer funds the next technician's quote.
 */
export async function releaseEscrowOnExit(job: JobRecord): Promise<void> {
  try {
    const refunds = await tx(async (db) => {
      const r = await refundEscrow(db, job.id, job.status === 'open' ? 'booking declined' : 'job cancelled');
      if (job.status === 'open') await db.query(`UPDATE jobs SET escrow_status = 'unfunded' WHERE id = $1 AND escrow_status = 'refunded'`, [job.id]);
      return r;
    });
    await runGatewayRefunds(refunds);
  } catch (err) {
    logger.error({ err, jobId: job.id }, 'escrow refund on exit failed');
  }
}

/** Customer confirms the work: release escrow now. */
export async function confirmCompletion(jobId: string, customerId: string) {
  const { job, refunds, capturedMinor } = await tx(async (db) => {
    const j = await one('SELECT status, customer_id, escrow_status FROM jobs WHERE id = $1 FOR UPDATE', [jobId], db);
    if (!j || j.customer_id !== customerId) throw notFound('Job');
    if (j.status !== 'completed') throw conflict('You can confirm once the technician marks the job completed');
    if (j.escrow_status !== 'held') throw conflict('Nothing is held in escrow for this job; pay to complete it');
    return captureEscrow(db, jobId, 'customer', { actorId: customerId });
  });
  if (job) await afterTransition(job);
  await runGatewayRefunds(refunds);
  return { job, capturedMinor };
}

/** Hourly sweep: completed jobs whose confirmation window passed are released automatically. */
export async function runEscrowAutoRelease(): Promise<number> {
  const { autoReleaseHours } = await getSetting('escrow');
  const due = await query<{ id: string }>(
    `SELECT id FROM jobs WHERE status = 'completed' AND escrow_status = 'held'
        AND completed_at <= now() - make_interval(hours => $1) LIMIT 200`,
    [autoReleaseHours],
  );
  let released = 0;
  for (const { id } of due) {
    try {
      const { job, refunds } = await tx((db) => captureEscrow(db, id, 'auto'));
      if (job) await afterTransition(job);
      await runGatewayRefunds(refunds);
      released++;
    } catch (err) {
      logger.error({ err, jobId: id }, 'escrow auto-release failed');
    }
  }
  return released;
}

/** Admin settles a disputed (or stuck) job: capture part/all, refund the rest; 0 cancels the job. */
export async function settleEscrow(jobId: string, adminId: string, captureMinor: number) {
  const { job, refunds } = await tx(async (db) => {
    const j = await one('SELECT status, escrow_status FROM jobs WHERE id = $1 FOR UPDATE', [jobId], db);
    if (!j) throw notFound('Job');
    if (j.escrow_status !== 'held') throw conflict('Nothing is held in escrow for this job');
    if (captureMinor > 0 && !['completed', 'disputed'].includes(j.status)) throw conflict('Only completed or disputed jobs can be settled from escrow');
    if (captureMinor === 0) {
      const r = await refundEscrow(db, jobId, 'admin settlement', adminId);
      const cancelled = j.status === 'cancelled' ? null : await transitionJob(jobId, 'cancelled', { id: adminId, role: 'admin' }, { db, note: 'escrow refunded in full' });
      return { job: cancelled, refunds: r };
    }
    return captureEscrow(db, jobId, 'admin', { captureMinor, actorId: adminId });
  });
  if (job) await afterTransition(job);
  await runGatewayRefunds(refunds);
  return job;
}
