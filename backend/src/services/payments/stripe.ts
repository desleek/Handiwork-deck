import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../config/env.ts';
import { PaymentError, type PaymentProvider, type WebhookEvent } from './types.ts';

const BASE = 'https://api.stripe.com/v1';

function form(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === undefined || v === null) return [];
    if (typeof v === 'object') return form(v as Record<string, unknown>, key);
    return [`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`];
  });
}

async function call<T = any>(method: string, path: string, body?: Record<string, unknown>, idem?: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      ...(idem ? { 'Idempotency-Key': idem } : {}),
    },
    body: body ? form(body).join('&') : undefined,
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new PaymentError('stripe', json.error?.message ?? `HTTP ${res.status}`, res.status >= 500);
  return json as T;
}

/**
 * Stripe (international / card fallback). The platform collects with a PaymentIntent and holds funds;
 * technician payouts go through our wallet ledger, so Stripe Connect transfers are optional here.
 * Physical-service marketplace: never Apple/Google IAP (Section 14a).
 */
export const stripe: PaymentProvider = {
  name: 'stripe',
  channels: ['card'],
  currencies: ['USD', 'GBP', 'EUR', 'NGN'],
  isConfigured: () => !!env.STRIPE_SECRET_KEY,

  async createCheckout(req) {
    const pi = await call(
      'POST',
      '/payment_intents',
      {
        amount: req.amountMinor,
        currency: req.currency.toLowerCase(),
        description: req.description,
        automatic_payment_methods: { enabled: true },
        metadata: { reference: req.reference, ...(req.metadata ?? {}) },
      },
      req.reference,
    );
    return { providerRef: pi.id, clientSecret: pi.client_secret };
  },

  async verify(ref) {
    const pi = await call('GET', `/payment_intents/${ref}`);
    const status = pi.status === 'succeeded' ? 'succeeded' : pi.status === 'canceled' ? 'failed' : 'pending';
    return { status, amountMinor: pi.amount_received ?? pi.amount, currency: String(pi.currency).toUpperCase(), raw: pi };
  },

  async refund(ref, amountMinor) {
    const r = await call('POST', '/refunds', { payment_intent: ref, amount: amountMinor });
    return { ok: r.status !== 'failed', raw: r };
  },

  parseWebhook(headers, rawBody): WebhookEvent | null {
    const header = String(headers['stripe-signature'] ?? '');
    const secret = env.STRIPE_WEBHOOK_SECRET;
    if (!secret || !header) return null;
    const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
    const signed = `${parts.t}.${rawBody.toString('utf8')}`;
    const expected = createHmac('sha256', secret).update(signed).digest('hex');
    const v1 = parts.v1 ?? '';
    if (v1.length !== expected.length || !timingSafeEqual(Buffer.from(v1), Buffer.from(expected))) return null;
    if (Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return null; // replay window
    const evt = JSON.parse(rawBody.toString('utf8'));
    const obj = evt.data?.object ?? {};
    const type: WebhookEvent['type'] =
      evt.type === 'payment_intent.succeeded' ? 'charge.succeeded' : evt.type === 'payment_intent.payment_failed' ? 'charge.failed' : 'other';
    return { eventId: evt.id, type, providerRef: obj.id, reference: obj.metadata?.reference, amountMinor: obj.amount_received, raw: evt };
  },
};
