import { splitFee } from '@handiwork/shared';
import express, { Router } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query, tx } from '../db/pool';
import { conflict, HttpError, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { afterTransition, transitionJob } from '../services/jobs/lifecycle';
import {
  getProvider,
  isProviderName,
  type NormalizedWebhookEvent,
  type ProviderName,
  WebhookSignatureError,
} from '../services/payments/index';

export const paymentsRouter = Router();

/**
 * Customer pays for a completed job. The charge is split at source: the platform
 * fee goes to us and the remainder to the technician's payee account.
 */
paymentsRouter.post('/jobs/:id/payments', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const customer = currentUser(req);
  const job = await one(
    `SELECT j.*, tp.payout_provider, tp.payout_account_ref
       FROM jobs j LEFT JOIN technician_profiles tp ON tp.user_id = j.technician_id
      WHERE j.id = $1 AND j.customer_id = $2`,
    [jobId, customer.id],
  );
  if (!job) throw notFound('Job');
  if (job.status !== 'completed') throw conflict('Payment is taken once the technician marks the job completed');
  if (!job.budget_minor) throw conflict('Job has no agreed amount');

  const existing = await one(
    `SELECT id, provider, checkout_url FROM payments WHERE job_id = $1 AND status = 'pending' AND checkout_url IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`,
    [jobId],
  );
  if (existing) {
    res.json({ paymentId: existing.id, provider: existing.provider, checkoutUrl: existing.checkout_url });
    return;
  }

  if (!job.payout_provider || !job.payout_account_ref) {
    throw new HttpError(409, 'The technician has not set up payouts yet', 'payee_not_onboarded');
  }
  const providerName = job.payout_provider as ProviderName;
  const provider = getProvider(providerName);
  const split = splitFee(Number(job.budget_minor), {
    bps: env.PLATFORM_FEE_BPS,
    min: env.PLATFORM_FEE_MIN_MINOR,
    max: env.PLATFORM_FEE_MAX_MINOR,
  });

  const payment = await one(
    `INSERT INTO payments (job_id, payer_id, payee_id, provider, provider_ref, amount_minor, platform_fee_minor, currency)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5, $6, $7) RETURNING id`,
    [jobId, customer.id, job.technician_id, providerName, split.gross, split.platformFee, job.currency],
  );
  try {
    const result = await provider.createSplitPayment({
      reference: payment.id,
      amount: split.gross,
      platformFee: split.platformFee,
      currency: job.currency,
      payeeAccountRef: job.payout_account_ref,
      customer: { email: customer.email ?? undefined, name: customer.full_name, phone: customer.phone_e164 ?? undefined },
      description: `HANDIWORK-DECK job ${job.ref}: ${job.title}`,
      callbackUrl: `${env.PUBLIC_BASE_URL}/v1/payments/return`,
      metadata: { jobId, jobRef: job.ref, paymentId: payment.id },
    });
    await query('UPDATE payments SET provider_ref = $2, checkout_url = $3 WHERE id = $1', [
      payment.id,
      result.providerRef,
      result.checkoutUrl ?? null,
    ]);
    res.status(201).json({
      paymentId: payment.id,
      provider: providerName,
      amountMinor: split.gross,
      platformFeeMinor: split.platformFee,
      currency: job.currency,
      checkoutUrl: result.checkoutUrl ?? null,
    });
  } catch (err) {
    await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [payment.id]);
    throw err;
  }
});

/** Landing page for hosted checkout redirects; the app closes its WebView on this URL. */
paymentsRouter.get('/payments/return', (_req, res) => {
  res.type('html').send('<!doctype html><title>Payment</title><p>Payment submitted. You can return to the app.</p>');
});

/** Applies a verified provider event. Idempotent on the provider's event id. */
export async function handlePaymentEvent(provider: ProviderName, event: NormalizedWebhookEvent): Promise<string> {
  if (event.type === 'ignored') return 'ignored';
  const { outcome, job } = await tx(async (db) => {
    const fresh = await one('INSERT INTO webhook_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [provider, event.id], db);
    if (!fresh) return { outcome: 'duplicate', job: null };

    const isUuid = event.reference && /^[0-9a-f-]{36}$/i.test(event.reference);
    const payment = await one(
      `SELECT * FROM payments WHERE provider = $1 AND (provider_ref = $2 OR ($3::uuid IS NOT NULL AND id = $3::uuid)) FOR UPDATE`,
      [provider, event.providerRef ?? null, isUuid ? event.reference : null],
      db,
    );
    if (!payment) {
      logger.warn({ provider, event: event.id }, 'webhook for unknown payment');
      return { outcome: 'unknown_payment', job: null };
    }

    switch (event.type) {
      case 'payment.succeeded': {
        if (payment.status === 'succeeded') return { outcome: 'already_succeeded', job: null };
        if (event.amount !== undefined && event.amount < Number(payment.amount_minor)) {
          logger.error({ paymentId: payment.id, got: event.amount, expected: payment.amount_minor }, 'underpayment');
          await db.query(`UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1`, [payment.id, event.raw]);
          return { outcome: 'amount_mismatch', job: null };
        }
        // Adopt the provider's final reference (e.g. Stripe session -> PaymentIntent id) for refunds.
        await db.query(`UPDATE payments SET status = 'succeeded', raw = $2, provider_ref = COALESCE($3, provider_ref) WHERE id = $1`, [
          payment.id,
          event.raw,
          event.providerRef ?? null,
        ]);
        const current = await one('SELECT status FROM jobs WHERE id = $1', [payment.job_id], db);
        let job = null;
        if (current?.status === 'completed') {
          job = await transitionJob(payment.job_id, 'paid', { id: null, role: 'system' }, { db, note: `payment ${payment.id}` });
          await db.query('UPDATE conversations SET is_open = false WHERE job_id = $1', [payment.job_id]);
        }
        return { outcome: 'paid', job };
      }
      case 'payment.failed':
        if (payment.status === 'pending') {
          await db.query(`UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1`, [payment.id, event.raw]);
        }
        return { outcome: 'failed', job: null };
      case 'refund.succeeded': {
        const refunded = event.amountIsCumulative
          ? (event.amount ?? Number(payment.amount_minor))
          : Number(payment.refunded_minor) + (event.amount ?? Number(payment.amount_minor));
        const status = refunded >= Number(payment.amount_minor) ? 'refunded' : 'partially_refunded';
        await db.query('UPDATE payments SET refunded_minor = $2, status = $3 WHERE id = $1', [payment.id, refunded, status]);
        return { outcome: status, job: null };
      }
      default:
        return { outcome: 'ignored', job: null };
    }
  });
  if (job) await afterTransition(job);
  return outcome;
}

/**
 * One webhook endpoint per provider. Must receive the raw body for signature
 * verification, so it is mounted before the JSON body parser.
 */
export const paymentWebhookRouter = Router();
paymentWebhookRouter.post('/webhooks/payments/:provider', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const name = String(req.params.provider);
  if (!isProviderName(name)) throw notFound('Provider');
  let event: NormalizedWebhookEvent;
  try {
    event = await getProvider(name).parseWebhook(req.body as Buffer, req.headers);
  } catch (err) {
    if (err instanceof WebhookSignatureError) {
      res.status(401).json({ error: { code: 'bad_signature', message: err.message } });
      return;
    }
    throw err;
  }
  const outcome = await handlePaymentEvent(name, event);
  logger.info({ provider: name, eventId: event.id, type: event.type, outcome }, 'payment webhook');
  res.json({ received: true, outcome });
});
