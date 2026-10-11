import { one, query, type Db } from '../db/pool.ts';
import { badRequest } from '../lib/http.ts';

export type LedgerType =
  | 'topup'
  | 'topup_bonus'
  | 'job_payment'
  | 'earning'
  | 'refund'
  | 'withdrawal'
  | 'withdrawal_fee'
  | 'withdrawal_reversal'
  | 'boost_purchase'
  | 'supplies_purchase'
  | 'supplies_sale'
  | 'adjustment';

/**
 * Post one signed entry to a user's wallet ledger and update the balance atomically.
 * Must run inside a transaction (pass the client). The balance row is locked, and the
 * CHECK (balance >= 0) constraint is the last line of defence against overdraft.
 */
export async function postLedger(
  db: Db,
  p: {
    userId: string;
    type: LedgerType;
    amountMinor: number;
    description: string;
    paymentId?: string | null;
    jobId?: string | null;
    withdrawalId?: string | null;
  },
): Promise<number> {
  await query('INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [p.userId], db);
  const w = await one<{ balance_minor: number }>('SELECT balance_minor FROM wallets WHERE user_id = $1 FOR UPDATE', [p.userId], db);
  const next = (w?.balance_minor ?? 0) + p.amountMinor;
  if (next < 0) throw badRequest('INSUFFICIENT_FUNDS', 'Wallet balance is too low');
  await query('UPDATE wallets SET balance_minor = $2, updated_at = now() WHERE user_id = $1', [p.userId, next], db);
  await query(
    `INSERT INTO wallet_ledger (user_id, type, amount_minor, balance_after_minor, payment_id, job_id, withdrawal_id, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [p.userId, p.type, p.amountMinor, next, p.paymentId ?? null, p.jobId ?? null, p.withdrawalId ?? null, p.description],
    db,
  );
  return next;
}

export async function getBalance(userId: string, db?: Db): Promise<number> {
  const w = await one<{ balance_minor: number }>('SELECT balance_minor FROM wallets WHERE user_id = $1', [userId], db);
  return w?.balance_minor ?? 0;
}
