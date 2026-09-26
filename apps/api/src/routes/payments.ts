import { PAYMENT_METHOD_LABEL, PAYMENT_METHODS } from '@handiwork/shared';
import express, { Router } from 'express';
import type pg from 'pg';
import { z } from 'zod';
import { one, query, tx } from '../db/pool';
import { badRequest, conflict, HttpError, notFound } from '../lib/errors';
import { logger } from '../lib/logger';
import { authenticate, currentUser, requireUser } from '../middleware/auth';
import { parse } from '../middleware/validate';
import { confirmCompletion, type FundOutcome, fundEscrow, notifyFunded, runGatewayRefunds } from '../services/escrow';
import { invoiceFor } from '../services/jobs/invoice';
import { afterTransition } from '../services/jobs/lifecycle';
import { candidatesOrReject, startCheckout } from '../services/payments/checkout';
import {
  dedicatedAccountGateway,
  type GatewayMethod,
  gatewaysFor,
  getProvider,
  isProviderName,
  type NormalizedWebhookEvent,
  type ProviderName,
  WebhookSignatureError,
} from '../services/payments/index';
import { activatePromotion } from '../services/promotions';
import { getSetting } from '../services/settings';
import { postToWallet } from '../services/wallet';

export const paymentsRouter = Router();

/** Payment methods the customer can choose from for a currency (card, virtual account, USSD, wallet). */
paymentsRouter.get('/payments/options', authenticate, requireUser(), async (req, res) => {
  const { currency } = parse(z.object({ currency: z.string().length(3).toUpperCase() }), req.query);
  const gateways = await gatewaysFor(currency);
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
  res.json({ currency, methods, virtualAccounts: !!(await dedicatedAccountGateway(currency)) });
});

const PayBody = z.object({
  method: z.enum(PAYMENT_METHODS).default('card'),
  /** Optional explicit gateway choice (e.g. the customer prefers Flutterwave or Paystack). */
  provider: z.enum(['stripe', 'paystack', 'flutterwave', 'mock']).optional(),
});

const FUNDABLE = ['assigned', 'en_route', 'in_progress', 'completed'];

/**
 * Section 11: the customer funds the accepted quote into escrow, through any
 * channel. Held funds are captured itemized when the customer confirms the work
 * (or auto-released); paying after completion counts as confirming.
 */
paymentsRouter.post('/jobs/:id/payments', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const b = parse(PayBody, req.body ?? {});
  const customer = currentUser(req);
  const job = await one('SELECT * FROM jobs WHERE id = $1 AND customer_id = $2', [jobId, customer.id]);
  if (!job) throw notFound('Job');
  if (!FUNDABLE.includes(job.status)) throw conflict('Payment opens once you accept a quote');
  if (job.escrow_status !== 'unfunded') throw new HttpError(409, 'This job is already paid into escrow', 'already_funded');
  const inv = await invoiceFor(jobId);
  const amount = inv.totals.total;
  const fee = inv.commission.platformFee;

  if (b.method === 'wallet') {
    const r = await tx(async (db) => {
      const locked = await one('SELECT escrow_status FROM jobs WHERE id = $1 FOR UPDATE', [jobId], db);
      if (locked.escrow_status !== 'unfunded') throw new HttpError(409, 'This job is already paid into escrow', 'already_funded');
      const payment = await one(
        `INSERT INTO payments (job_id, payer_id, payee_id, provider, provider_ref, amount_minor, platform_fee_minor, currency,
                               status, method, settlement)
         VALUES ($1, $2, $3, 'wallet', gen_random_uuid()::text, $4, $5, $6, 'succeeded', 'wallet', 'escrow') RETURNING *`,
        [jobId, customer.id, job.technician_id, amount, fee, job.currency],
        db,
      );
      await postToWallet(db, { userId: customer.id, currency: job.currency, amountMinor: -amount, kind: 'job_payment', paymentId: payment.id, jobId, memo: `Job ${job.ref} (escrow)` });
      return { payment, ...(await fundEscrow(db, payment)) };
    });
    await afterPaymentEvent(r);
    res.status(201).json({
      paymentId: r.payment.id,
      status: 'succeeded',
      method: 'wallet',
      settlement: 'escrow',
      escrow: r.outcome,
      amountMinor: amount,
      platformFeeMinor: fee,
      currency: job.currency,
    });
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
    res.json({ paymentId: existing.id, provider: existing.provider, method, settlement: 'escrow', amountMinor: amount, checkoutUrl: existing.checkout_url });
    return;
  }

  const candidates = await candidatesOrReject(job.currency, method, b.provider);
  const payment = await one(
    `INSERT INTO payments (job_id, payer_id, payee_id, provider, provider_ref, amount_minor, platform_fee_minor, currency, method, settlement)
     VALUES ($1, $2, $3, $4, gen_random_uuid()::text, $5, $6, $7, $8, 'escrow') RETURNING id`,
    [jobId, customer.id, job.technician_id, candidates[0], amount, fee, job.currency, method],
  );
  const checkout = await startCheckout(payment.id, candidates, {
    amount,
    platformFee: fee,
    currency: job.currency,
    method,
    customer,
    description: `HANDIWORK-DECK job ${job.ref}: ${job.title}`,
    metadata: { jobId, jobRef: job.ref, paymentId: payment.id },
  });
  res.status(201).json({
    paymentId: payment.id,
    provider: checkout.provider,
    method,
    settlement: 'escrow',
    amountMinor: amount,
    platformFeeMinor: fee,
    currency: job.currency,
    checkoutUrl: checkout.checkoutUrl,
  });
});

async function afterPaymentEvent(r: FundOutcome) {
  if (r.job) await afterTransition(r.job);
  await runGatewayRefunds(r.refunds);
  if (r.outcome === 'held' && r.fundedJobId) await notifyFunded(r.fundedJobId);
}

/** Escrow state for a job: what is held, and the itemized capture once released. */
paymentsRouter.get('/jobs/:id/escrow', authenticate, requireUser(), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const user = currentUser(req);
  const job = await one('SELECT customer_id, technician_id, status, escrow_status, completed_at FROM jobs WHERE id = $1', [jobId]);
  if (!job || (user.role !== 'admin' && user.id !== job.customer_id && user.id !== job.technician_id)) throw notFound('Job');
  const hold = await one('SELECT * FROM escrow_holds WHERE job_id = $1', [jobId]);
  const { autoReleaseHours } = await getSetting('escrow');
  const autoReleaseAt =
    job.status === 'completed' && job.escrow_status === 'held' && job.completed_at
      ? new Date(new Date(job.completed_at).getTime() + autoReleaseHours * 3_600_000)
      : null;
  res.json({ status: job.escrow_status, hold, autoReleaseAt });
});

/** Customer confirms the work is done: escrow is captured itemized and the technician is paid. */
paymentsRouter.post('/jobs/:id/confirm-completion', authenticate, requireUser('customer'), async (req, res) => {
  const jobId = parse(z.uuid(), req.params.id);
  const { job, capturedMinor } = await confirmCompletion(jobId, currentUser(req).id);
  res.json({ job, capturedMinor });
});

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
  const candidates = await candidatesOrReject(b.currency, b.method, b.provider);
  const payment = await one(
    `INSERT INTO payments (purpose, payer_id, provider, provider_ref, amount_minor, platform_fee_minor, currency, method, settlement)
     VALUES ('wallet_topup', $1, $2, gen_random_uuid()::text, $3, 0, $4, $5, 'platform_collect') RETURNING id`,
    [user.id, candidates[0], b.amountMinor, b.currency, b.method],
  );
  const checkout = await startCheckout(payment.id, candidates, {
    amount: b.amountMinor,
    platformFee: 0,
    currency: b.currency,
    method: b.method,
    customer: user,
    description: 'HANDIWORK-DECK wallet top-up',
    metadata: { paymentId: payment.id, purpose: 'wallet_topup' },
  });
  res.status(201).json({ paymentId: payment.id, provider: checkout.provider, checkoutUrl: checkout.checkoutUrl });
});

// ---------------------------------------------------------------- dedicated virtual accounts
/**
 * Section 11 bank transfer, per customer: a permanent account number (Paystack
 * dedicated NUBAN / Flutterwave virtual account). Anything paid into it tops up
 * the wallet, from which jobs are funded into escrow. Per-transaction transfer
 * accounts come from the gateway checkout when `bank_transfer` is chosen.
 */
paymentsRouter.get('/wallet/virtual-account', authenticate, requireUser('customer'), async (req, res) => {
  const { currency } = parse(z.object({ currency: z.string().length(3).toUpperCase().default('NGN') }), req.query);
  const account = await one(
    'SELECT provider, currency, account_number, account_name, bank_name, created_at FROM customer_virtual_accounts WHERE user_id = $1 AND currency = $2',
    [currentUser(req).id, currency],
  );
  res.json({ account: account ?? null, available: !!(await dedicatedAccountGateway(currency)) });
});

paymentsRouter.post('/wallet/virtual-account', authenticate, requireUser('customer'), async (req, res) => {
  const { currency, bvn } = parse(z.object({ currency: z.string().length(3).toUpperCase().default('NGN'), bvn: z.string().regex(/^\d{11}$/).optional() }), req.body ?? {});
  const user = currentUser(req);
  const existing = await one('SELECT * FROM customer_virtual_accounts WHERE user_id = $1 AND currency = $2', [user.id, currency]);
  if (existing) {
    res.json({ account: existing });
    return;
  }
  const provider = await dedicatedAccountGateway(currency);
  if (!provider) throw badRequest(`Dedicated transfer accounts aren't available in ${currency}`);
  const gateway = getProvider(provider);
  if (!gateway.createDedicatedAccount) throw badRequest(`${provider} can't issue dedicated accounts`);
  const created = await gateway.createDedicatedAccount({
    userId: user.id,
    name: user.full_name,
    email: user.email ?? undefined,
    phone: user.phone_e164 ?? undefined,
    currency,
    bvn,
  });
  const account = await one(
    `INSERT INTO customer_virtual_accounts (user_id, provider, currency, provider_ref, account_number, account_name, bank_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING provider, currency, account_number, account_name, bank_name, created_at`,
    [user.id, provider, currency, created.providerRef, created.accountNumber, created.accountName ?? null, created.bankName ?? null],
  );
  res.status(201).json({ account });
});

/** Landing page for hosted checkout redirects; the app closes its WebView on this URL. */
paymentsRouter.get('/payments/return', (_req, res) => {
  res.type('html').send('<!doctype html><title>Payment</title><p>Payment submitted. You can return to the app.</p>');
});

/** A transfer into a customer's dedicated account: record it and credit their wallet. */
async function creditVirtualAccount(db: pg.PoolClient, provider: ProviderName, event: NormalizedWebhookEvent): Promise<string> {
  const va = await one('SELECT * FROM customer_virtual_accounts WHERE provider = $1 AND provider_ref = $2', [provider, event.accountRef ?? null], db);
  if (!va || !event.amount || event.amount <= 0) {
    logger.warn({ provider, event: event.id }, 'transfer to unknown virtual account');
    return 'unknown_account';
  }
  const payment = await one(
    `INSERT INTO payments (purpose, payer_id, provider, provider_ref, amount_minor, platform_fee_minor, currency, status, method, settlement, raw)
     VALUES ('wallet_topup', $1, $2, $3, $4, 0, $5, 'succeeded', 'bank_transfer', 'platform_collect', $6) RETURNING id`,
    [va.user_id, provider, event.providerRef ?? event.id, event.amount, va.currency, event.raw],
    db,
  );
  await postToWallet(db, { userId: va.user_id, currency: va.currency, amountMinor: event.amount, kind: 'topup', paymentId: payment.id, memo: 'Bank transfer to your HANDIWORK account' });
  return 'wallet_credited';
}

type EventResult = { outcome: string; fund?: FundOutcome };

/** Applies a verified provider event. Idempotent on the provider's event id. */
export async function handlePaymentEvent(provider: ProviderName, event: NormalizedWebhookEvent): Promise<string> {
  if (event.type === 'ignored') return 'ignored';
  const result = await tx<EventResult>(async (db) => {
    const fresh = await one('INSERT INTO webhook_events (provider, event_id) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING 1', [provider, event.id], db);
    if (!fresh) return { outcome: 'duplicate' };
    if (event.type === 'virtual_account.credited') return { outcome: await creditVirtualAccount(db, provider, event) };

    const isUuid = event.reference && /^[0-9a-f-]{36}$/i.test(event.reference);
    const payment = await one(
      `SELECT * FROM payments WHERE provider = $1 AND (provider_ref = $2 OR ($3::uuid IS NOT NULL AND id = $3::uuid)) FOR UPDATE`,
      [provider, event.providerRef ?? null, isUuid ? event.reference : null],
      db,
    );
    if (!payment) {
      logger.warn({ provider, event: event.id }, 'webhook for unknown payment');
      return { outcome: 'unknown_payment' };
    }

    switch (event.type) {
      case 'payment.succeeded': {
        if (payment.status === 'succeeded') return { outcome: 'already_succeeded' };
        if (event.amount !== undefined && event.amount < Number(payment.amount_minor)) {
          logger.error({ paymentId: payment.id, got: event.amount, expected: payment.amount_minor }, 'underpayment');
          await db.query(`UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1`, [payment.id, event.raw]);
          if (payment.purpose === 'promotion') await db.query(`UPDATE promotion_purchases SET status = 'failed' WHERE id = $1`, [payment.promotion_purchase_id]);
          return { outcome: 'amount_mismatch' };
        }
        // Adopt the provider's final reference (e.g. Stripe session -> PaymentIntent id) for refunds.
        const updated = await one(`UPDATE payments SET status = 'succeeded', raw = $2, provider_ref = COALESCE($3, provider_ref) WHERE id = $1 RETURNING *`, [
          payment.id,
          event.raw,
          event.providerRef ?? null,
        ], db);
        if (payment.purpose === 'wallet_topup') {
          await postToWallet(db, { userId: payment.payer_id, currency: payment.currency, amountMinor: Number(payment.amount_minor), kind: 'topup', paymentId: payment.id, memo: `Top-up via ${provider}` });
          return { outcome: 'wallet_credited' };
        }
        if (payment.purpose === 'promotion') {
          await activatePromotion(db, payment.promotion_purchase_id);
          return { outcome: 'promotion_activated' };
        }
        const fund = await fundEscrow(db, updated);
        return { outcome: fund.outcome === 'captured' ? 'paid' : fund.outcome === 'held' ? 'escrow_held' : 'refunded_orphan', fund };
      }
      case 'payment.failed':
        if (payment.status === 'pending') {
          await db.query(`UPDATE payments SET status = 'failed', raw = $2 WHERE id = $1`, [payment.id, event.raw]);
          if (payment.purpose === 'promotion') await db.query(`UPDATE promotion_purchases SET status = 'failed' WHERE id = $1`, [payment.promotion_purchase_id]);
        }
        return { outcome: 'failed' };
      case 'refund.succeeded': {
        const refunded = event.amountIsCumulative
          ? (event.amount ?? Number(payment.amount_minor))
          : Number(payment.refunded_minor) + (event.amount ?? Number(payment.amount_minor));
        const status = refunded >= Number(payment.amount_minor) ? 'refunded' : 'partially_refunded';
        await db.query('UPDATE payments SET refunded_minor = $2, status = $3 WHERE id = $1', [payment.id, refunded, status]);
        return { outcome: status };
      }
      default:
        return { outcome: 'ignored' };
    }
  });
  if (result.fund) await afterPaymentEvent(result.fund);
  return result.outcome;
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
