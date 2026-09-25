import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type PaymentMethod, splitFee } from '@handiwork/shared';
import express, { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { env } from '../config/env';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { type AppUser, authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { afterTransition, type JobRecord, transitionJob } from '../services/jobs/lifecycle';
import {
  availableGateways,
  chooseGateway,
  getProvider,
  isProviderName,
  type NormalizedWebhookEvent,
  type ProviderName,
  WebhookSignatureError,
} from '../services/payments/index';
import { postToWallet } from '../services/wallet';

export const paymentsRouter = Router();

type GatewayMethod = Exclude<PaymentMethod, 'wallet'>;

const feeFor = (gross: number) =>
  splitFee(gross, { bps: env.PLATFORM_FEE_BPS, min: env.PLATFORM_FEE_MIN_MINOR, max: env.PLATFORM_FEE_MAX_MINOR });

/** Payment methods the customer can choose from for a currency (card, virtual account, USSD, wallet). */
paymentsRouter.get('/payments/options', authenticate, requireUser(), async (req, res) => {
  const { currency } = parse(z.object({ currency: z.string().length(3).toUpperCase() }), req.query);
  const gateways = availableGateways(currency);
  const wallet = await one<{ balance_minor: number }>('SELECT balance_minor FROM wallets WHERE user_id = $1 AND currency = $2', [
    currentUser(req).id,
    currency,
  ]);
  const methods = PAYMENT_METHODS.map((method) => ({
    method,
    label: PAYMENT_METHOD_LABEL[method],
    providers: method === 'wallet' ? [] : gateways.filter((g) => g.methods.includes(method)).map((g) => g.provider),
    ...(method === 'wallet' ? { balanceMinor: wallet?.balance_minor ?? 0 } : {}),
  })).filter((m) => m.method === 'wallet' || m.providers.length > 0);
  res.json({ currency, methods });
});

const PayBody = z.object({
  method: z.enum(PAYMENT_METHODS).default('card'),
  /** Optional explicit gateway choice (e.g. the customer prefers Flutterwave or Paystack). */
  provider: z.enum(['stripe', 'paystack', 'flutterwave', 'mock']).optional(),
});

/**
 * Customer pays for a completed job.
 *  - wallet: settled instantly from the customer's wallet; technician's share credited to theirs.
 *  - gateway on the technician's payout provider: split at source (platform fee to us, rest to them).
 *  - any other gateway: platform collects, technician's share is credited to their wallet on success.
 */
paymentsRouter.post('/jobs/:id/payments', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(PayBody, req.body ?? {});
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
  const split = feeFor(Number(job.budget_minor));

  if (b.method === 'wallet') {
    const paid = await tx(async (db) => {
      await db.query('SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const payment = await one(
        `INSERT INTO payments (job_id, payer_id, payee_id, provider, provider_ref, amount_minor, platform_fee_minor, currency,
                               status, method, settlement)
         VALUES ($1, $2, $3, 'wallet', gen_random_uuid()::text, $4, $5, $6, 'succeeded', 'wallet', 'wallet') RETURNING *`,
        [jobId, customer.id, job.technician_id, split.gross, split.platformFee, job.currency],
        db,
      );
      await postToWallet(db, { userId: customer.id, currency: job.currency, amountMinor: -split.gross, kind: 'job_payment', paymentId: payment.id, jobId, memo: `Job ${job.ref}` });
      await postToWallet(db, { userId: job.technician_id, currency: job.currency, amountMinor: split.payeeAmount, kind: 'job_earning', paymentId: payment.id, jobId, memo: `Job ${job.ref}` });
      const updated = await markJobPaid(db, jobId, payment.id);
      return { payment, updated };
    });
    if (paid.updated) await afterTransition(paid.updated);
    res.status(201).json({ paymentId: paid.payment.id, status: 'succeeded', method: 'wallet', amountMinor: split.gross, platformFeeMinor: split.platformFee, currency: job.currency });
    return;
  }

  const method = b.method as GatewayMethod;
  const existing = await one(
    `SELECT id, provider, checkout_url FROM payments
      WHERE job_id = $1 AND status = 'pending' AND checkout_url IS NOT NULL AND method = $2 AND ($3::payment_provider IS NULL OR provider = $3)
      ORDER BY created_at DESC LIMIT 1`,
    [jobId, method, b.provider ?? null],
  );
  if (existing) {
    res.json({ paymentId: existing.id, provider: existing.provider, method, checkoutUrl: existing.checkout_url });
    return;
  }

  let providerName: ProviderName;
  try {
    providerName = chooseGateway(job.currency, method, { requested: b.provider, preferred: job.payout_provider });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  const splitAtSource = providerName === job.payout_provider && !!job.payout_account_ref;
  const settlement = splitAtSource ? 'split' : 'platform_collect';

  const payment = await one(
    `INSERT INTO payments (job_id, payer_id, payee_id, provider, provider_ref, amount_minor, platform_fee_minor, currency, method, settlement)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5, $6, $7, $8, $9) RETURNING id`,
    [jobId, customer.id, job.technician_id, providerName, split.gross, split.platformFee, job.currency, method, settlement],
  );
  const result = await startCheckout(payment.id, providerName, {
    amount: split.gross,
    platformFee: split.platformFee,
    currency: job.currency,
    payeeAccountRef: splitAtSource ? job.payout_account_ref : undefined,
    method,
    customer,
    description: `HANDIWORK-DECK job ${job.ref}: ${job.title}`,
    metadata: { jobId, jobRef: job.ref, paymentId: payment.id },
  });
  res.status(201).json({
    paymentId: payment.id,
    provider: providerName,
    method,
    settlement,
    amountMinor: split.gross,
    platformFeeMinor: split.platformFee,
    currency: job.currency,
    checkoutUrl: result.checkoutUrl ?? null,
  });
});

async function startCheckout(
  paymentId: string,
  providerName: ProviderName,
  p: {
    amount: number;
    platformFee: number;
    currency: string;
    payeeAccountRef?: string;
    method: GatewayMethod;
    customer: AppUser;
    description: string;
    metadata: Record<string, string>;
  },
) {
  try {
    const result = await getProvider(providerName).createSplitPayment({
      reference: paymentId,
      amount: p.amount,
      platformFee: p.platformFee,
      currency: p.currency,
      payeeAccountRef: p.payeeAccountRef,
      methods: [p.method],
      customer: { email: p.customer.email ?? undefined, name: p.customer.full_name, phone: p.customer.phone_e164 ?? undefined },
      description: p.description,
      callbackUrl: `${env.PUBLIC_BASE_URL}/v1/payments/return`,
      metadata: p.metadata,
    });
    await query('UPDATE payments SET provider_ref = $2, checkout_url = $3 WHERE id = $1', [paymentId, result.providerRef, result.checkoutUrl ?? null]);
    return result;
  } catch (err) {
    await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
    throw err;
  }
}

async function markJobPaid(db: pg.PoolClient, jobId: string, paymentId: string): Promise<JobRecord | null> {
  const current = await one('SELECT status FROM jobs WHERE id = $1', [jobId], db);
  if (current?.status !== 'completed') return null;
  const job = await transitionJob(jobId, 'paid', { id: null, role: 'system' }, { db, note: `payment ${paymentId}` });
  await db.query('UPDATE conversations SET is_open = false WHERE job_id = $1', [jobId]);
  return job;
}

// ---------------------------------------------------------------- wallet
paymentsRouter.get('/wallet', authenticate, requireUser(), async (req, res) => {
  const userId = currentUser(req).id;
  const [balances, entries] = await Promise.all([
    query('SELECT currency, balance_minor FROM wallets WHERE user_id = $1 ORDER BY currency', [userId]),
    query(
      `SELECT l.id, l.currency, l.amount_minor, l.kind, l.memo, l.created_at, j.ref AS job_ref
         FROM wallet_ledger l LEFT JOIN jobs j ON j.id = l.job_id
        WHERE l.user_id = $1 ORDER BY l.created_at DESC LIMIT 50`,
      [userId],
    ),
  ]);
  res.json({ balances, entries });
});

const TopupBody = z.object({
  amountMinor: z.number().int().positive(),
  currency: z.string().length(3).toUpperCase(),
  method: z.enum(['card', 'bank_transfer', 'ussd']).default('card'),
  provider: z.enum(['stripe', 'paystack', 'flutterwave', 'mock']).optional(),
});

/** Fund the in-app wallet through a gateway; credited when the provider confirms payment. */
paymentsRouter.post('/wallet/topups', authenticate, requireUser('customer'), async (req, res) => {
  const b = parse(TopupBody, req.body);
  const user = currentUser(req);
  let providerName: ProviderName;
  try {
    providerName = chooseGateway(b.currency, b.method, { requested: b.provider });
  } catch (err) {
    throw badRequest((err as Error).message);
  }
  const payment = await one(
    `INSERT INTO payments (purpose, payer_id, provider, provider_ref, amount_minor, platform_fee_minor, currency, method, settlement)
     VALUES ('wallet_topup', $1, $2, gen_random_uuid()::text, $3, 0, $4, $5, 'platform_collect') RETURNING id`,
    [user.id, providerName, b.amountMinor, b.currency, b.method],
  );
  const result = await startCheckout(payment.id, providerName, {
    amount: b.amountMinor,
    platformFee: 0,
    currency: b.currency,
    method: b.method,
    customer: user,
    description: 'HANDIWORK-DECK wallet top-up',
    metadata: { paymentId: payment.id, purpose: 'wallet_topup' },
  });
  res.status(201).json({ paymentId: payment.id, provider: providerName, checkoutUrl: result.checkoutUrl ?? null });
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
        if (payment.purpose === 'wallet_topup') {
          await postToWallet(db, { userId: payment.payer_id, currency: payment.currency, amountMinor: Number(payment.amount_minor), kind: 'topup', paymentId: payment.id, memo: `Top-up via ${provider}` });
          return { outcome: 'wallet_credited', job: null };
        }
        if (payment.settlement === 'platform_collect') {
          const share = Number(payment.amount_minor) - Number(payment.platform_fee_minor);
          await postToWallet(db, { userId: payment.payee_id, currency: payment.currency, amountMinor: share, kind: 'job_earning', paymentId: payment.id, jobId: payment.job_id });
        }
        return { outcome: 'paid', job: await markJobPaid(db, payment.job_id, payment.id) };
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
