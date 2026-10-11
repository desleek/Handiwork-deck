import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.ts';
import { PaymentError, type CheckoutRequest, type PaymentProvider, type WebhookEvent } from './types.ts';

const BASE = 'https://api.paystack.co';

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { status?: boolean; message?: string; data?: T };
  if (!res.ok || json.status === false) {
    throw new PaymentError('paystack', json.message ?? `HTTP ${res.status}`, res.status >= 500);
  }
  return json.data as T;
}

/**
 * Paystack (primary Nigerian gateway).
 * card → Standard checkout; bank_transfer → Pay with Transfer / dedicated virtual account;
 * ussd → Charge API with ussd channel. Transfers power standard & instant payouts.
 */
export const paystack: PaymentProvider = {
  name: 'paystack',
  channels: ['card', 'bank_transfer', 'ussd'],
  currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'],
  isConfigured: () => !!env.PAYSTACK_SECRET_KEY,

  async createCheckout(req: CheckoutRequest) {
    if (req.channel === 'ussd') {
      const data = await call('POST', '/charge', {
        email: req.customer.email,
        amount: req.amountMinor,
        reference: req.reference,
        ussd: { type: '737' }, // GTBank by default; client can pick a bank
        metadata: req.metadata,
      });
      return { providerRef: data.reference, ussd: { code: data.ussd_code ?? data.display_text } };
    }
    if (req.channel === 'bank_transfer') {
      const data = await call('POST', '/charge', {
        email: req.customer.email,
        amount: req.amountMinor,
        reference: req.reference,
        bank_transfer: { account_expires_at: new Date(Date.now() + 30 * 60_000).toISOString() },
        metadata: req.metadata,
      });
      return {
        providerRef: data.reference,
        virtualAccount: {
          bankName: data.bank?.name ?? data.bank_name,
          accountNumber: data.account_number,
          accountName: data.account_name,
          expiresAt: data.account_expires_at,
        },
      };
    }
    const data = await call('POST', '/transaction/initialize', {
      email: req.customer.email,
      amount: req.amountMinor,
      currency: req.currency,
      reference: req.reference,
      callback_url: req.callbackUrl,
      channels: ['card'],
      metadata: req.metadata,
    });
    return { providerRef: data.reference, authorizationUrl: data.authorization_url };
  },

  async verify(ref) {
    const data = await call('GET', `/transaction/verify/${encodeURIComponent(ref)}`);
    const status = data.status === 'success' ? 'succeeded' : data.status === 'failed' || data.status === 'abandoned' ? 'failed' : 'pending';
    return { status, amountMinor: data.amount, currency: data.currency, feeMinor: data.fees, raw: data };
  },

  async refund(ref, amountMinor) {
    const data = await call('POST', '/refund', { transaction: ref, amount: amountMinor });
    return { ok: true, raw: data };
  },

  async createTransferRecipient({ accountNumber, bankCode, name }) {
    const data = await call('POST', '/transferrecipient', {
      type: 'nuban',
      name,
      account_number: accountNumber,
      bank_code: bankCode,
      currency: 'NGN',
    });
    return { recipientCode: data.recipient_code, accountName: data.details?.account_name ?? name };
  },

  async transfer(req) {
    // Paystack transfers settle near-instantly on NIP; "standard" is batched next business day by our queue.
    const data = await call('POST', '/transfer', {
      source: 'balance',
      amount: req.amountMinor,
      recipient: req.recipientCode,
      reference: req.reference,
      reason: req.reason,
    });
    return { providerRef: data.transfer_code, status: data.status === 'success' ? 'succeeded' : 'pending' };
  },

  parseWebhook(headers, rawBody): WebhookEvent | null {
    const sig = String(headers['x-paystack-signature'] ?? '');
    if (!env.PAYSTACK_SECRET_KEY || !sig) return null;
    const expected = createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
    if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
    const evt = JSON.parse(rawBody.toString('utf8'));
    const d = evt.data ?? {};
    const map: Record<string, WebhookEvent['type']> = {
      'charge.success': 'charge.succeeded',
      'charge.failed': 'charge.failed',
      'transfer.success': 'transfer.succeeded',
      'transfer.failed': 'transfer.failed',
      'transfer.reversed': 'transfer.failed',
    };
    return {
      eventId: `${evt.event}:${d.id ?? d.reference}`,
      type: map[evt.event] ?? 'other',
      providerRef: d.reference ?? d.transfer_code,
      reference: d.reference,
      amountMinor: d.amount,
      raw: evt,
    };
  },
};
