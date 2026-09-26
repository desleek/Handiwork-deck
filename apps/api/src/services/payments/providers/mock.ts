import { createHmac, randomUUID } from 'node:crypto';
import { header, type NormalizedWebhookEvent, type PaymentProvider, WebhookSignatureError } from '../types';

export const MOCK_WEBHOOK_SECRET = 'mock-webhook-secret';

/** In-memory provider for local development and tests. Never enabled in production. */
export class MockProvider implements PaymentProvider {
  readonly name = 'mock' as const;

  async onboardPayee(input: Parameters<PaymentProvider['onboardPayee']>[0]) {
    return { accountRef: `mock_acct_${input.userId}` };
  }

  async createSplitPayment(input: Parameters<PaymentProvider['createSplitPayment']>[0]) {
    return { providerRef: input.reference, checkoutUrl: `https://mock.pay/checkout/${input.reference}?methods=${input.methods.join(',')}` };
  }

  /** Sign a payload the same way `parseWebhook` expects, for tests and local tooling. */
  static sign(body: string) {
    return createHmac('sha256', MOCK_WEBHOOK_SECRET).update(body).digest('hex');
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NormalizedWebhookEvent> {
    if (header(headers, 'x-mock-signature') !== MockProvider.sign(rawBody.toString('utf8'))) {
      throw new WebhookSignatureError('mock');
    }
    const payload = JSON.parse(rawBody.toString('utf8'));
    return { id: payload.id ?? randomUUID(), type: payload.type, providerRef: payload.reference, reference: payload.reference, amount: payload.amount, raw: payload };
  }

  async payout(input: Parameters<PaymentProvider['payout']>[0]) {
    if (input.payee.accountNumber === 'FAIL') throw new Error('Mock bank rejected the transfer');
    return { providerRef: `mock_payout_${input.reference}`, status: 'sent' as const };
  }

  async refund(input: Parameters<PaymentProvider['refund']>[0]) {
    return { refundRef: `mock_refund_${input.providerRef}` };
  }
}
