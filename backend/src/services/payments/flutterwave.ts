import { timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.ts';
import { PaymentError, type PaymentProvider, type WebhookEvent } from './types.ts';

const BASE = 'https://api.flutterwave.com/v3';

async function call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${env.FLUTTERWAVE_SECRET_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as { status?: string; message?: string; data?: T; meta?: any };
  if (!res.ok || json.status === 'error') {
    throw new PaymentError('flutterwave', json.message ?? `HTTP ${res.status}`, res.status >= 500);
  }
  return { ...(json.data as object), _meta: json.meta } as T;
}

/** Flutterwave amounts are in major units. */
const major = (minor: number) => minor / 100;
const minor = (major: number) => Math.round(major * 100);

export const flutterwave: PaymentProvider = {
  name: 'flutterwave',
  channels: ['card', 'bank_transfer', 'ussd'],
  currencies: ['NGN', 'GHS', 'KES', 'ZAR', 'UGX', 'TZS', 'USD'],
  isConfigured: () => !!env.FLUTTERWAVE_SECRET_KEY,

  async createCheckout(req) {
    if (req.channel === 'bank_transfer') {
      const data: any = await call('POST', '/charges?type=bank_transfer', {
        tx_ref: req.reference,
        amount: major(req.amountMinor),
        currency: req.currency,
        email: req.customer.email,
        meta: req.metadata,
      });
      const auth = data._meta?.authorization ?? {};
      return {
        providerRef: req.reference,
        virtualAccount: {
          bankName: auth.transfer_bank,
          accountNumber: auth.transfer_account,
          accountName: auth.transfer_note ?? 'Handiwork-Deck',
          expiresAt: auth.account_expiration,
        },
      };
    }
    if (req.channel === 'ussd') {
      const data: any = await call('POST', '/charges?type=ussd', {
        tx_ref: req.reference,
        account_bank: '058',
        amount: major(req.amountMinor),
        currency: req.currency,
        email: req.customer.email,
      });
      return { providerRef: req.reference, ussd: { code: data._meta?.authorization?.note } };
    }
    const data: any = await call('POST', '/payments', {
      tx_ref: req.reference,
      amount: major(req.amountMinor),
      currency: req.currency,
      redirect_url: req.callbackUrl,
      payment_options: 'card',
      customer: { email: req.customer.email, name: req.customer.name, phonenumber: req.customer.phone ?? undefined },
      customizations: { title: 'Handiwork-Deck', description: req.description },
      meta: req.metadata,
    });
    return { providerRef: req.reference, authorizationUrl: data.link };
  },

  async verify(txRef) {
    const data: any = await call('GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    const status = data.status === 'successful' ? 'succeeded' : data.status === 'failed' ? 'failed' : 'pending';
    return { status, amountMinor: minor(data.amount), currency: data.currency, feeMinor: minor(data.app_fee ?? 0), raw: data };
  },

  async refund(txRef, amountMinor) {
    const v: any = await call('GET', `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(txRef)}`);
    const data = await call('POST', `/transactions/${v.id}/refund`, { amount: major(amountMinor) });
    return { ok: true, raw: data };
  },

  async createTransferRecipient({ accountNumber, bankCode, name }) {
    const data: any = await call('POST', '/accounts/resolve', { account_number: accountNumber, account_bank: bankCode });
    // Flutterwave transfers take bank details directly; we tokenise as "bank:account".
    return { recipientCode: `${bankCode}:${accountNumber}`, accountName: data.account_name ?? name };
  },

  async transfer(req) {
    const [bank, account] = req.recipientCode.split(':');
    const data: any = await call('POST', '/transfers', {
      account_bank: bank,
      account_number: account,
      amount: major(req.amountMinor),
      currency: req.currency,
      reference: req.reference,
      narration: req.reason,
      debit_currency: req.currency,
    });
    return { providerRef: String(data.id), status: data.status === 'SUCCESSFUL' ? 'succeeded' : 'pending' };
  },

  parseWebhook(headers, rawBody): WebhookEvent | null {
    const sig = String(headers['verif-hash'] ?? '');
    const expected = env.FLUTTERWAVE_WEBHOOK_HASH ?? '';
    if (!expected || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      return null;
    }
    const evt = JSON.parse(rawBody.toString('utf8'));
    const d = evt.data ?? {};
    const isTransfer = String(evt.event ?? '').startsWith('transfer');
    const ok = d.status === 'successful' || d.status === 'SUCCESSFUL';
    return {
      eventId: `${evt.event}:${d.id}`,
      type: isTransfer ? (ok ? 'transfer.succeeded' : 'transfer.failed') : ok ? 'charge.succeeded' : 'charge.failed',
      providerRef: d.tx_ref ?? d.reference,
      reference: d.tx_ref ?? d.reference,
      amountMinor: d.amount !== undefined ? minor(d.amount) : undefined,
      raw: evt,
    };
  },
};
