import { randomUUID } from 'node:crypto';
import { one, query, tx, type Db } from '../../db/pool.ts';
import { splitPayment } from '../../domain/pricing.ts';
import { bonusWindowEnd, topupBonus } from '../../domain/wallet.ts';
import { badRequest, conflict, notFound } from '../../lib/http.ts';
import { logger } from '../../lib/logger.ts';
import { getJob, logJobEvent, transition } from '../jobs.ts';
import { notify } from '../notifications/notify.ts';
import { liveQuote, totalsOf } from '../quotes.ts';
import { getSettings } from '../settings.ts';
import { postLedger } from '../wallet.ts';
import { checkoutWithFallback, getProvider } from './router.ts';
import type { Channel } from './types.ts';

export type Purpose = 'job' | 'consultancy' | 'milestone' | 'boost' | 'push_alert' | 'wallet_topup' | 'ad_campaign';

export interface StartPaymentInput {
  payer: { id: string; email: string | null; full_name: string; phone_e164: string | null };
  purpose: Purpose;
  amountMinor: number;
  currency: string;
  channel: Channel | 'wallet';
  description: string;
  jobId?: string;
  quoteId?: string;
  boostId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Single entry point for every money-in flow (Section 11): jobs, consultancy, milestones,
 * boosts, push alerts, wallet top-ups. Wallet payments settle immediately; gateway payments
 * settle when the provider webhook (or verify call) confirms.
 */
export async function startPayment(input: StartPaymentInput) {
  if (input.purpose === 'wallet_topup' && input.channel === 'wallet') {
    throw badRequest('INVALID_CHANNEL', 'Cannot top up a wallet from the wallet');
  }
  const id = randomUUID();

  if (input.channel === 'wallet') {
    await tx(async (db) => {
      await query(
        `INSERT INTO payments (id, payer_id, purpose, job_id, quote_id, boost_id, channel, provider, amount_minor, currency, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,'wallet','wallet',$7,$8,$9)`,
        [id, input.payer.id, input.purpose, input.jobId ?? null, input.quoteId ?? null, input.boostId ?? null,
          input.amountMinor, input.currency, JSON.stringify(input.metadata ?? {})],
        db,
      );
      await postLedger(db, {
        userId: input.payer.id,
        type: input.purpose === 'boost' || input.purpose === 'push_alert' ? 'boost_purchase' : 'job_payment',
        amountMinor: -input.amountMinor,
        description: input.description,
        paymentId: id,
        jobId: input.jobId,
      });
    });
    await onPaymentSucceeded(id, null);
    return { paymentId: id, status: 'held' as const, checkout: {} };
  }

  const settings = await getSettings();
  const { provider, result } = await checkoutWithFallback(settings.gatewayPriority, {
    reference: id,
    amountMinor: input.amountMinor,
    currency: input.currency,
    channel: input.channel,
    customer: {
      id: input.payer.id,
      email: input.payer.email ?? `${input.payer.id}@users.handiworkdeck.com`,
      name: input.payer.full_name,
      phone: input.payer.phone_e164,
    },
    description: input.description,
    metadata: { purpose: input.purpose, jobId: input.jobId, ...(input.metadata ?? {}) },
  });
  await query(
    `INSERT INTO payments (id, payer_id, purpose, job_id, quote_id, boost_id, channel, provider, provider_ref, amount_minor, currency, checkout, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [id, input.payer.id, input.purpose, input.jobId ?? null, input.quoteId ?? null, input.boostId ?? null, input.channel,
      provider.name, result.providerRef, input.amountMinor, input.currency, JSON.stringify(result), JSON.stringify(input.metadata ?? {})],
  );
  if (input.channel === 'bank_transfer' && result.virtualAccount) {
    await query(
      `INSERT INTO virtual_accounts (user_id, provider, bank_name, account_number, account_name, is_dedicated, payment_id)
       VALUES ($1,$2,$3,$4,$5,false,$6)`,
      [input.payer.id, provider.name, result.virtualAccount.bankName, result.virtualAccount.accountNumber, result.virtualAccount.accountName, id],
    );
  }
  return { paymentId: id, status: 'initiated' as const, provider: provider.name, checkout: result };
}

/**
 * Idempotent settlement. Money is now held by the platform (escrow). Side effects per purpose.
 */
export async function onPaymentSucceeded(paymentId: string, feeMinor: number | null) {
  const effects: (() => Promise<void>)[] = [];
  await tx(async (db) => {
    const p = await one<any>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId], db);
    if (!p) throw notFound('Payment');
    if (p.status !== 'initiated') return; // already processed
    await query(`UPDATE payments SET status = 'held', held_at = now(), processing_fee_minor = $2 WHERE id = $1`, [paymentId, feeMinor], db);

    switch (p.purpose) {
      case 'job': {
        const job = await getJob(p.job_id, db, true);
        if (job.status === 'approved') {
          await transition(db, job, 'funded', p.payer_id, { event: { paymentId, amountMinor: p.amount_minor } });
          effects.push(() =>
            notify({ userId: job.technician_id, type: 'job.funded', title: 'Job funded', body: `Payment for job #${job.short_code} is secured. Contact details are now unlocked.`, data: { jobId: job.id } }),
          );
        } else {
          // Late payment (job cancelled/closed, or already funded by another attempt): never leave money stranded.
          await logJobEvent(db, job.id, null, 'payment.late_refund', { paymentId, jobStatus: job.status });
          effects.push(() =>
            tx((db2) => refundPayment(db2, paymentId, p.amount_minor, `Refund: job #${job.short_code} was no longer awaiting payment`)),
          );
          effects.push(() =>
            notify({ userId: p.payer_id, type: 'payment.refunded', title: 'Payment refunded', body: `Job #${job.short_code} was no longer awaiting payment, so your payment is being refunded.`, data: { jobId: job.id } }),
          );
        }
        break;
      }
      case 'wallet_topup': {
        await postLedger(db, { userId: p.payer_id, type: 'topup', amountMinor: p.amount_minor, description: 'Wallet top-up', paymentId });
        const s = await getSettings();
        const user = await one<{ created_at: Date; wallet_bonus_until: Date | null }>('SELECT created_at, wallet_bonus_until FROM users WHERE id = $1', [p.payer_id], db);
        const bonus = topupBonus({
          amountMinor: p.amount_minor,
          now: new Date(),
          windowEnd: bonusWindowEnd(user!.created_at, s.walletBonusWindowDays, user!.wallet_bonus_until),
          tiers: s.walletBonusTiers,
          enabled: s.features.walletBonus,
        });
        if (bonus.bonusMinor > 0) {
          await postLedger(db, {
            userId: p.payer_id,
            type: 'topup_bonus',
            amountMinor: bonus.bonusMinor,
            description: `Top-up bonus (${bonus.bonusBps / 100}%)`,
            paymentId,
          });
        }
        await query(`UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`, [paymentId], db);
        break;
      }
      case 'boost': {
        await query(
          `UPDATE boosts SET status = CASE WHEN starts_at <= now() THEN 'active' ELSE 'scheduled' END WHERE id = $1 AND status = 'pending_payment'`,
          [p.boost_id],
          db,
        );
        await capturePlatformRevenue(db, paymentId, 'boost', p.amount_minor);
        break;
      }
      case 'push_alert': {
        await capturePlatformRevenue(db, paymentId, 'push_alert', p.amount_minor);
        const alertId = p.metadata?.alertId;
        if (alertId) {
          effects.push(async () => {
            const { enqueuePushAlert } = await import('../../queue/queues.ts');
            await enqueuePushAlert(alertId);
          });
        }
        break;
      }
      default:
        break;
    }
  });
  for (const e of effects) await e().catch((err) => logger.warn({ err }, 'post-payment effect failed'));
}

async function capturePlatformRevenue(db: Db, paymentId: string, component: string, amountMinor: number) {
  await query(`UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`, [paymentId], db);
  await query(
    `INSERT INTO payment_splits (payment_id, recipient, component, amount_minor) VALUES ($1, 'platform', $2, $3)`,
    [paymentId, component, amountMinor],
    db,
  );
}

/**
 * Itemized capture → split payout, on customer confirmation of completion.
 * Technician receives labor & markup net of commission plus the full base part cost
 * into their wallet; platform keeps commissions.
 */
export async function captureJobPayment(db: Db, jobId: string, actorId: string) {
  const payment = await one<any>(
    `SELECT * FROM payments WHERE job_id = $1 AND purpose = 'job' AND status = 'held' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
    [jobId],
    db,
  );
  if (!payment) throw conflict('NOT_FUNDED', 'No held payment for this job');
  const job = await getJob(jobId, db);
  const quote = await liveQuote(db, jobId);
  if (quote.status !== 'approved') throw conflict('QUOTE_NOT_APPROVED', 'Quote is not approved');
  const totals = totalsOf(quote);
  if (totals.customerTotalMinor !== payment.amount_minor) {
    throw conflict('AMOUNT_MISMATCH', 'Held amount does not match the approved quote');
  }
  const splits = splitPayment(totals);
  for (const s of splits) {
    await query(
      `INSERT INTO payment_splits (payment_id, recipient, user_id, component, amount_minor) VALUES ($1,$2,$3,$4,$5)`,
      [payment.id, s.recipient, s.recipient === 'technician' ? job.technician_id : null, s.component, s.amountMinor],
      db,
    );
  }
  const techTotal = splits.filter((s) => s.recipient === 'technician').reduce((a, s) => a + s.amountMinor, 0);
  await postLedger(db, {
    userId: job.technician_id,
    type: 'earning',
    amountMinor: techTotal,
    description: `Earnings for job #${job.short_code}`,
    paymentId: payment.id,
    jobId,
  });
  await query(`UPDATE payments SET status = 'captured', captured_at = now() WHERE id = $1`, [payment.id], db);
  await logJobEvent(db, jobId, actorId, 'payment.captured', { paymentId: payment.id, splits });
}

/** Refund a held payment (cancellation before work, dispute outcome). Wallet payments go back to the wallet. */
export async function refundPayment(db: Db, paymentId: string, amountMinor: number, reason: string) {
  const p = await one<any>('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId], db);
  if (!p) throw notFound('Payment');
  if (!['held', 'captured'].includes(p.status)) throw conflict('NOT_REFUNDABLE', `Payment is ${p.status}`);
  if (amountMinor > p.amount_minor) throw badRequest('REFUND_TOO_LARGE', 'Refund exceeds payment');
  if (p.provider === 'wallet') {
    await postLedger(db, { userId: p.payer_id, type: 'refund', amountMinor, description: reason, paymentId, jobId: p.job_id });
  } else {
    await getProvider(p.provider).refund(p.provider_ref, amountMinor);
  }
  await query(
    `UPDATE payments SET status = $2 WHERE id = $1`,
    [paymentId, amountMinor === p.amount_minor ? 'refunded' : 'partially_refunded'],
    db,
  );
  await query(
    `INSERT INTO payment_splits (payment_id, recipient, user_id, component, amount_minor) VALUES ($1, 'customer_refund', $2, 'refund', $3)`,
    [paymentId, p.payer_id, amountMinor],
    db,
  );
}
