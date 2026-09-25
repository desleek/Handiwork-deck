import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { extractInboundMessages, parseJobRef, verifyWhatsAppSignature } from '../src/services/messaging/whatsapp';
import { parseCurrencyRoutes } from '../src/services/payments/index';
import { FlutterwaveProvider } from '../src/services/payments/providers/flutterwave';
import { PaystackProvider } from '../src/services/payments/providers/paystack';
import { WebhookSignatureError } from '../src/services/payments/types';
import { CloudinaryStorage } from '../src/services/storage/index';

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('Paystack provider', () => {
  const secret = 'sk_test_abc';

  it('verifies the HMAC-SHA512 webhook signature and normalises charge.success', async () => {
    const p = new PaystackProvider(secret);
    const body = JSON.stringify({ event: 'charge.success', data: { id: 42, reference: 'pay-1', amount: 500000, currency: 'NGN' } });
    const sig = createHmac('sha512', secret).update(body).digest('hex');
    const ev = await p.parseWebhook(Buffer.from(body), { 'x-paystack-signature': sig });
    expect(ev).toMatchObject({ id: 'charge.success:42', type: 'payment.succeeded', reference: 'pay-1', amount: 500000 });
  });

  it('rejects a bad signature', async () => {
    const p = new PaystackProvider(secret);
    await expect(p.parseWebhook(Buffer.from('{}'), { 'x-paystack-signature': 'nope' })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it('initialises a split transaction with the platform fee as transaction_charge', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: true, message: 'ok', data: { authorization_url: 'https://checkout.paystack.com/x', reference: 'pay-1' } }));
    const p = new PaystackProvider(secret, fetchMock as unknown as typeof fetch);
    const res = await p.createSplitPayment({
      reference: 'pay-1',
      amount: 100_000,
      platformFee: 10_000,
      currency: 'NGN',
      payeeAccountRef: 'ACCT_123',
      methods: ['card', 'ussd'],
      customer: { email: 'a@b.co', name: 'Ada' },
      description: 'job',
      metadata: {},
    });
    expect(res.checkoutUrl).toBe('https://checkout.paystack.com/x');
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).toMatchObject({ amount: 100_000, subaccount: 'ACCT_123', transaction_charge: 10_000, bearer: 'subaccount', channels: ['card', 'ussd'] });
  });
});

describe('platform-collected payments', () => {
  it('omits the split when there is no payee account', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: true, message: 'ok', data: { authorization_url: 'u', reference: 'r' } }));
    const p = new PaystackProvider('sk', fetchMock as unknown as typeof fetch);
    await p.createSplitPayment({ reference: 'r', amount: 5000, platformFee: 0, currency: 'NGN', methods: ['bank_transfer'], customer: { email: 'a@b.co', name: 'A' }, description: 'topup', metadata: {} });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent).not.toHaveProperty('subaccount');
    expect(sent.channels).toEqual(['bank_transfer']);
  });
});

describe('Flutterwave provider', () => {
  it('sends the payee share in major units as a flat subaccount charge', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ status: 'success', message: 'ok', data: { link: 'https://flw/checkout' } }));
    const p = new FlutterwaveProvider('FLWSECK', 'hash', fetchMock as unknown as typeof fetch);
    await p.createSplitPayment({
      reference: 'pay-2',
      amount: 250_000,
      platformFee: 25_000,
      currency: 'KES',
      payeeAccountRef: 'RS_1',
      methods: ['card', 'bank_transfer'],
      customer: { email: 'a@b.co', name: 'Ada' },
      description: 'job',
      metadata: {},
    });
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(sent.amount).toBe(2500);
    expect(sent.payment_options).toBe('card,banktransfer');
    expect(sent.subaccounts[0]).toEqual({ id: 'RS_1', transaction_charge_type: 'flat_subaccount', transaction_charge: 2250 });
  });

  it('re-verifies successful charges with the API before reporting success', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ status: 'success', message: 'ok', data: { status: 'successful', amount: 2500, currency: 'KES', tx_ref: 'pay-2' } }),
    );
    const p = new FlutterwaveProvider('FLWSECK', 'hash', fetchMock as unknown as typeof fetch);
    const body = JSON.stringify({ event: 'charge.completed', data: { id: 9, tx_ref: 'pay-2', status: 'successful', amount: 2500, currency: 'KES' } });
    const ev = await p.parseWebhook(Buffer.from(body), { 'verif-hash': 'hash' });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/transactions/9/verify'), expect.anything());
    expect(ev).toMatchObject({ type: 'payment.succeeded', reference: 'pay-2', amount: 250_000 });
    await expect(p.parseWebhook(Buffer.from(body), { 'verif-hash': 'wrong' })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe('payment routing config', () => {
  it('parses currency routes', () => {
    expect(parseCurrencyRoutes('ngn:paystack, KES:flutterwave')).toEqual({ NGN: 'paystack', KES: 'flutterwave' });
    expect(() => parseCurrencyRoutes('NGN:paypal')).toThrow();
  });
});

describe('WhatsApp helpers', () => {
  it('verifies X-Hub-Signature-256', () => {
    const body = Buffer.from('{"a":1}');
    const sig = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifyWhatsAppSignature(body, sig, 'app-secret')).toBe(true);
    expect(verifyWhatsAppSignature(body, sig, 'other')).toBe(false);
    expect(verifyWhatsAppSignature(body, undefined, 'app-secret')).toBe(false);
  });

  it('extracts inbound text messages', () => {
    const msgs = extractInboundMessages({
      entry: [{ changes: [{ value: { messages: [{ id: 'wamid.1', from: '2348011111111', type: 'text', text: { body: 'hello' }, timestamp: '1700000000' }] } }] }],
    });
    expect(msgs).toEqual([{ waMessageId: 'wamid.1', fromE164: '+2348011111111', text: 'hello', timestamp: new Date(1700000000 * 1000) }]);
  });

  it('parses a leading job reference', () => {
    expect(parseJobRef('#hw-7k2qd: on my way')).toEqual({ ref: 'HW-7K2QD', body: 'on my way' });
    expect(parseJobRef('no ref here')).toEqual({ body: 'no ref here' });
  });
});

describe('Cloudinary storage', () => {
  it('signs upload params per Cloudinary spec (sorted, sha1 with secret appended)', () => {
    const c = new CloudinaryStorage('demo', 'key', 'secret');
    // sha1("public_id=a&timestamp=1secret")
    expect(c.sign({ timestamp: '1', public_id: 'a' })).toBe('d1f5b9e5d3702820c62b4f0ffde458e77d38ec27');
  });
});
