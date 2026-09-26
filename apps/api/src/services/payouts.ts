import { one, pool, tx } from '../db/pool';
import { logger } from '../lib/logger';
import { jobs } from '../queues/index';
import { getProvider, type ProviderName } from './payments/index';
import { getSetting } from './settings';
import { postToWallet } from './wallet';

export type PayoutSpeed = 'standard' | 'instant';

/** Instant payouts carry a fee (bps with a per-currency minimum); standard payouts are free. */
export async function payoutFee(amountMinor: number, currency: string, speed: PayoutSpeed): Promise<number> {
  if (speed === 'standard') return 0;
  const cfg = await getSetting('payouts');
  const pct = Math.round((amountMinor * cfg.instantFeeBps) / 10_000);
  return Math.max(pct, cfg.instantFeeMinMinor[currency] ?? 0);
}

/** Standard payouts go out in the next daily batch. */
export async function nextStandardBatch(now = new Date()): Promise<Date> {
  const { standardBatchHourUtc } = await getSetting('payouts');
  const at = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), standardBatchHourUtc));
  if (at <= now) at.setUTCDate(at.getUTCDate() + 1);
  return at;
}

/**
 * Sends one payout to the technician's bank / connected account. The wallet was
 * debited at request time; a failed transfer refunds it in full (fee included).
 */
export async function processPayout(payoutId: string): Promise<string> {
  const payout = await tx(async (db) => {
    const p = await one(
      `SELECT p.*, u.full_name, tp.payout_provider, tp.payout_account_ref, tp.payout_recipient_ref, tp.payout_bank_code, tp.payout_account_number
         FROM payouts p JOIN users u ON u.id = p.technician_id JOIN technician_profiles tp ON tp.user_id = p.technician_id
        WHERE p.id = $1 FOR UPDATE OF p`,
      [payoutId],
      db,
    );
    if (!p || p.status !== 'requested') return null;
    await db.query(`UPDATE payouts SET status = 'processing', provider = $2 WHERE id = $1`, [payoutId, p.payout_provider]);
    return p;
  });
  if (!payout) return 'skipped';

  try {
    const result = await getProvider(payout.payout_provider as ProviderName).payout({
      reference: payout.id,
      amountMinor: Number(payout.net_minor),
      currency: payout.currency,
      speed: payout.speed,
      payee: {
        name: payout.full_name,
        accountRef: payout.payout_account_ref,
        recipientRef: payout.payout_recipient_ref,
        bankCode: payout.payout_bank_code,
        accountNumber: payout.payout_account_number,
      },
    });
    await pool.query(`UPDATE payouts SET status = 'sent', provider_ref = $2 WHERE id = $1`, [payoutId, result.providerRef]);
    await jobs().notify(payout.technician_id, { title: 'Payout sent', body: `Your ${payout.speed} withdrawal is on its way.`, data: { type: 'payout.sent', payoutId } });
    return 'sent';
  } catch (err) {
    const reason = (err as Error).message.slice(0, 500);
    logger.error({ err, payoutId }, 'payout failed');
    await tx(async (db) => {
      await db.query(`UPDATE payouts SET status = 'failed', failure_reason = $2 WHERE id = $1`, [payoutId, reason]);
      await postToWallet(db, {
        userId: payout.technician_id,
        currency: payout.currency,
        amountMinor: Number(payout.amount_minor),
        kind: 'refund',
        payoutId,
        memo: 'Payout failed — returned to wallet',
      });
    });
    await jobs().notify(payout.technician_id, { title: 'Payout failed', body: 'We returned the money to your wallet. Please check your bank details.', data: { type: 'payout.failed', payoutId } });
    return 'failed';
  }
}
