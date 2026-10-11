import { Router } from 'express';
import { z } from 'zod';
import { one, query, tx } from '../db/pool.ts';
import { bonusWindowEnd, withdrawalQuote } from '../domain/wallet.ts';
import { badRequest, conflict, forbidden, notFound, parse } from '../lib/http.ts';
import { logger } from '../lib/logger.ts';
import { authenticate, requireUser } from '../middleware/auth.ts';
import { startPayment } from '../services/payments/escrow.ts';
import { getProvider } from '../services/payments/router.ts';
import { getSettings } from '../services/settings.ts';
import { getBalance, postLedger } from '../services/wallet.ts';

export const wallet = Router();
wallet.use(authenticate, requireUser());

const feeCfg = (s: Awaited<ReturnType<typeof getSettings>>) => ({
  standardFeeMinor: s.withdrawalStandardFeeMinor,
  instantFeeBps: s.withdrawalInstantFeeBps,
  instantMinMinor: s.withdrawalInstantFeeMinMinor,
  instantMaxMinor: s.withdrawalInstantFeeMaxMinor,
});

wallet.get('/', async (req, res) => {
  const s = await getSettings();
  const u = await one<{ created_at: Date; wallet_bonus_until: Date | null }>('SELECT created_at, wallet_bonus_until FROM users WHERE id = $1', [req.user!.id]);
  const end = bonusWindowEnd(u!.created_at, s.walletBonusWindowDays, u!.wallet_bonus_until);
  res.json({
    balanceMinor: await getBalance(req.user!.id),
    currency: s.currency,
    topupBonus: s.features.walletBonus && end > new Date() ? { activeUntil: end, tiers: s.walletBonusTiers } : null,
    withdrawals: {
      enabled: req.user!.role === 'technician' || s.customerWithdrawalsEnabled,
      fees: feeCfg(s),
    },
  });
});

/** Full auditable ledger, visible in-app (Section 15). */
wallet.get('/ledger', async (req, res) => {
  const q = parse(z.object({ before: z.coerce.number().int().optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }), req.query);
  res.json(
    await query(
      `SELECT id, type, amount_minor, balance_after_minor, description, job_id, payment_id, withdrawal_id, created_at
         FROM wallet_ledger WHERE user_id = $1 AND ($2::bigint IS NULL OR id < $2) ORDER BY id DESC LIMIT $3`,
      [req.user!.id, q.before ?? null, q.limit],
    ),
  );
});

wallet.post('/topups', async (req, res) => {
  const b = parse(z.object({ amountMinor: z.number().int().min(100 * 100), channel: z.enum(['card', 'bank_transfer', 'ussd']) }), req.body);
  const s = await getSettings();
  res.status(201).json(
    await startPayment({ payer: req.user!, purpose: 'wallet_topup', amountMinor: b.amountMinor, currency: s.currency, channel: b.channel, description: 'Wallet top-up' }),
  );
});

wallet.get('/bank-accounts', async (req, res) => {
  res.json(await query('SELECT id, bank_name, bank_code, account_last4, account_name, is_default FROM bank_accounts WHERE user_id = $1', [req.user!.id]));
});

wallet.post('/bank-accounts', async (req, res) => {
  const b = parse(z.object({ bankCode: z.string().min(3).max(10), bankName: z.string().min(2), accountNumber: z.string().regex(/^\d{10}$/, 'NUBAN account numbers have 10 digits') }), req.body);
  const s = await getSettings();
  const providerName = s.gatewayPriority.find((n) => n !== 'stripe' && getProvider(n).isConfigured()) ?? 'mock';
  const provider = getProvider(providerName);
  // Resolves the account name with the bank and tokenises it; the full number is not stored by us.
  const r = await provider.createTransferRecipient!({ accountNumber: b.accountNumber, bankCode: b.bankCode, name: req.user!.full_name });
  const acct = await tx(async (db) => {
    await query('UPDATE bank_accounts SET is_default = false WHERE user_id = $1', [req.user!.id], db);
    return one(
      `INSERT INTO bank_accounts (user_id, bank_code, bank_name, account_last4, account_name, provider_recipient_code)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, bank_name, account_last4, account_name, is_default`,
      [req.user!.id, b.bankCode, b.bankName, b.accountNumber.slice(-4), r.accountName, `${provider.name}|${r.recipientCode}`],
      db,
    );
  });
  res.status(201).json(acct);
});

/** Fee shown before confirming — standard (free/low, next business day) vs instant (small fee, same minute). */
wallet.get('/withdrawals/quote', async (req, res) => {
  const q = parse(z.object({ amountMinor: z.coerce.number().int().positive() }), req.query);
  const s = await getSettings();
  const balance = await getBalance(req.user!.id);
  res.json({
    standard: { ...withdrawalQuote(q.amountMinor, balance, 'standard', feeCfg(s)), eta: 'Next business day' },
    instant: { ...withdrawalQuote(q.amountMinor, balance, 'instant', feeCfg(s)), eta: 'Within minutes' },
  });
});

wallet.get('/withdrawals', async (req, res) => {
  res.json(await query('SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100', [req.user!.id]));
});

wallet.post('/withdrawals', async (req, res) => {
  const b = parse(z.object({ amountMinor: z.number().int().positive(), speed: z.enum(['standard', 'instant']), bankAccountId: z.string().uuid() }), req.body);
  const s = await getSettings();
  if (req.user!.role !== 'technician' && !s.customerWithdrawalsEnabled) {
    throw forbidden('WITHDRAWALS_DISABLED', 'Wallet-to-bank withdrawals for customers are coming soon');
  }
  const acct = await one<any>('SELECT * FROM bank_accounts WHERE id = $1 AND user_id = $2', [b.bankAccountId, req.user!.id]);
  if (!acct) throw notFound('Bank account');
  const balance = await getBalance(req.user!.id);
  const quote = withdrawalQuote(b.amountMinor, balance, b.speed, feeCfg(s));
  if (!quote.ok) throw badRequest('INVALID_AMOUNT', 'Amount exceeds your balance or is smaller than the fee');

  const w = await tx(async (db) => {
    const row = await one<any>(
      `INSERT INTO withdrawals (user_id, bank_account_id, amount_minor, fee_minor, speed) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.user!.id, acct.id, b.amountMinor, quote.feeMinor, b.speed],
      db,
    );
    // Debit the full amount now; the fee is recorded as its own ledger line for transparency.
    await postLedger(db, { userId: req.user!.id, type: 'withdrawal', amountMinor: -(b.amountMinor - quote.feeMinor), description: `Withdrawal to ${acct.bank_name} ••${acct.account_last4}`, withdrawalId: row.id });
    if (quote.feeMinor > 0) {
      await postLedger(db, { userId: req.user!.id, type: 'withdrawal_fee', amountMinor: -quote.feeMinor, description: `${b.speed === 'instant' ? 'Instant' : 'Standard'} withdrawal fee`, withdrawalId: row.id });
    }
    return row;
  });

  if (b.speed === 'instant') {
    const [providerName, recipientCode] = String(acct.provider_recipient_code).split('|');
    try {
      const r = await getProvider(providerName).transfer!({
        reference: w.id,
        amountMinor: quote.receiveMinor,
        currency: s.currency,
        recipientCode,
        reason: 'Handiwork-Deck instant payout',
        speed: 'instant',
      });
      await query(`UPDATE withdrawals SET status = $2, provider = $3, provider_ref = $4, completed_at = CASE WHEN $2 = 'paid' THEN now() END WHERE id = $1`, [
        w.id, r.status === 'succeeded' ? 'paid' : 'processing', providerName, r.providerRef,
      ]);
    } catch (err) {
      logger.error({ err, withdrawalId: w.id }, 'instant transfer failed; reversing');
      await tx(async (db) => {
        await query(`UPDATE withdrawals SET status = 'reversed' WHERE id = $1`, [w.id], db);
        await postLedger(db, { userId: req.user!.id, type: 'withdrawal_reversal', amountMinor: b.amountMinor, description: 'Withdrawal failed — funds returned', withdrawalId: w.id });
      });
      throw conflict('TRANSFER_FAILED', 'The transfer could not be completed. Your funds have been returned to your wallet.');
    }
  } else {
    const [providerName] = String(acct.provider_recipient_code).split('|');
    await query('UPDATE withdrawals SET provider = $2 WHERE id = $1', [w.id, providerName]);
  }
  res.status(201).json({ id: w.id, ...quote, speed: b.speed });
});
