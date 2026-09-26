import type pg from 'pg';
import { HttpError } from '../lib/errors';

export type WalletEntryKind = 'topup' | 'job_payment' | 'job_earning' | 'refund' | 'withdrawal' | 'adjustment' | 'promotion' | 'fee';

/**
 * Posts a signed amount to a user's wallet and records it in the ledger, inside
 * the caller's transaction. Returns false if this (payment, user, kind) was
 * already posted (idempotent for webhook retries). Throws 409 on insufficient funds.
 */
export async function postToWallet(
  db: pg.PoolClient,
  e: {
    userId: string;
    currency: string;
    amountMinor: number;
    kind: WalletEntryKind;
    paymentId?: string;
    jobId?: string;
    payoutId?: string;
    promotionId?: string;
    memo?: string;
  },
): Promise<boolean> {
  if (!Number.isInteger(e.amountMinor) || e.amountMinor === 0) throw new Error('wallet amount must be a non-zero integer');
  await db.query('SAVEPOINT wallet_post');
  try {
    const inserted = await db.query(
      `INSERT INTO wallet_ledger (user_id, currency, amount_minor, kind, payment_id, job_id, payout_id, promotion_id, memo)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT DO NOTHING RETURNING id`,
      [e.userId, e.currency, e.amountMinor, e.kind, e.paymentId ?? null, e.jobId ?? null, e.payoutId ?? null, e.promotionId ?? null, e.memo ?? null],
    );
    if (!inserted.rowCount) {
      await db.query('RELEASE SAVEPOINT wallet_post');
      return false;
    }
    if (e.amountMinor > 0) {
      await db.query(
        `INSERT INTO wallets (user_id, currency, balance_minor) VALUES ($1, $2, $3)
         ON CONFLICT (user_id, currency) DO UPDATE SET balance_minor = wallets.balance_minor + EXCLUDED.balance_minor, updated_at = now()`,
        [e.userId, e.currency, e.amountMinor],
      );
    } else {
      // Debits can't upsert: Postgres checks CHECK (balance >= 0) on the proposed INSERT row
      // before ON CONFLICT. A debit needs an existing wallet anyway.
      const updated = await db.query(
        'UPDATE wallets SET balance_minor = balance_minor + $3, updated_at = now() WHERE user_id = $1 AND currency = $2',
        [e.userId, e.currency, e.amountMinor],
      );
      if (!updated.rowCount) throw Object.assign(new Error('no wallet'), { code: '23514' });
    }
    await db.query('RELEASE SAVEPOINT wallet_post');
  } catch (err) {
    await db.query('ROLLBACK TO SAVEPOINT wallet_post');
    // CHECK (balance_minor >= 0) violated: a debit larger than the balance.
    if ((err as { code?: string }).code === '23514') throw new HttpError(409, 'Insufficient wallet balance', 'insufficient_funds');
    throw err;
  }
  return true;
}

export async function walletBalance(db: pg.PoolClient, userId: string, currency: string): Promise<number> {
  const r = await db.query<{ balance_minor: number }>('SELECT balance_minor FROM wallets WHERE user_id = $1 AND currency = $2', [userId, currency]);
  return r.rows[0]?.balance_minor ?? 0;
}
