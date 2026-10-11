import { env } from '../../config/env.ts';
import type { PaymentProvider } from './types.ts';

/**
 * Local-development gateway. Charges "succeed" when the client calls POST /payments/:id/mock-complete.
 * Enabled only with PAYMENTS_ENABLE_MOCK=true and never in production.
 */
const succeeded = new Set<string>();

export function markMockPaid(ref: string) {
  succeeded.add(ref);
}

export const mock: PaymentProvider = {
  name: 'mock',
  channels: ['card', 'bank_transfer', 'ussd'],
  currencies: ['NGN', 'USD'],
  isConfigured: () => env.PAYMENTS_ENABLE_MOCK && env.NODE_ENV !== 'production',

  async createCheckout(req) {
    const ref = `mock_${req.reference}`;
    if (req.channel === 'bank_transfer') {
      return { providerRef: ref, virtualAccount: { bankName: 'Mock Bank', accountNumber: '0123456789', accountName: 'HANDIWORK/MOCK' } };
    }
    if (req.channel === 'ussd') return { providerRef: ref, ussd: { code: '*737*000*1234#' } };
    return { providerRef: ref, authorizationUrl: `${env.PUBLIC_API_URL}/payments/mock-checkout/${req.reference}` };
  },
  async verify(ref) {
    return { status: succeeded.has(ref) ? 'succeeded' : 'pending', amountMinor: 0, currency: 'NGN' };
  },
  async refund() {
    return { ok: true };
  },
  async createTransferRecipient({ accountNumber, bankCode, name }) {
    return { recipientCode: `mock:${bankCode}:${accountNumber}`, accountName: name };
  },
  async transfer(req) {
    return { providerRef: `mock_tr_${req.reference}`, status: req.speed === 'instant' ? 'succeeded' : 'pending' };
  },
  parseWebhook() {
    return null;
  },
};
