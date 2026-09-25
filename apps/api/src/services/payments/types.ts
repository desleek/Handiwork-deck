import type { MinorUnits } from '@handiwork/shared';

export type ProviderName = 'stripe' | 'paystack' | 'flutterwave' | 'mock';

export interface PayeeOnboardingInput {
  userId: string;
  email?: string;
  fullName: string;
  country: string; // ISO-3166 alpha-2
  /** Bank details for Paystack / Flutterwave subaccounts. Stripe collects these in hosted onboarding. */
  bank?: { bankCode: string; accountNumber: string };
  /** Where Stripe should send the technician back to after hosted onboarding. */
  returnUrl?: string;
}

export interface PayeeOnboardingResult {
  accountRef: string;
  /** Hosted onboarding link (Stripe Express); absent when onboarding is complete. */
  onboardingUrl?: string;
}

export interface SplitPaymentInput {
  /** Our payment id; used as the idempotency key / provider reference. */
  reference: string;
  amount: MinorUnits;
  platformFee: MinorUnits;
  currency: string;
  payeeAccountRef: string;
  customer: { email?: string; name: string; phone?: string };
  description: string;
  callbackUrl?: string;
  metadata: Record<string, string>;
}

export interface SplitPaymentResult {
  providerRef: string;
  /** Hosted checkout URL the app opens in a browser / WebView. */
  checkoutUrl?: string;
  raw?: unknown;
}

export type NormalizedEventType = 'payment.succeeded' | 'payment.failed' | 'refund.succeeded' | 'ignored';

export interface NormalizedWebhookEvent {
  id: string; // provider event id, for idempotency
  type: NormalizedEventType;
  providerRef?: string;
  /** Our own reference, when the provider echoes it back. */
  reference?: string;
  amount?: MinorUnits;
  currency?: string;
  /** For refunds: whether `amount` is the running total refunded (Stripe) rather than this refund alone. */
  amountIsCumulative?: boolean;
  raw: unknown;
}

/**
 * Every payment provider implements this contract. The rest of the codebase talks
 * only to this interface, so providers can be swapped or routed per-currency.
 */
export interface PaymentProvider {
  readonly name: ProviderName;
  onboardPayee(input: PayeeOnboardingInput): Promise<PayeeOnboardingResult>;
  createSplitPayment(input: SplitPaymentInput): Promise<SplitPaymentResult>;
  /** Verifies the signature and normalises the payload. Throws on a bad signature. */
  parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NormalizedWebhookEvent>;
  refund(input: { providerRef: string; amount?: MinorUnits; currency: string }): Promise<{ refundRef: string }>;
}

export class WebhookSignatureError extends Error {
  constructor(provider: string) {
    super(`Invalid ${provider} webhook signature`);
  }
}

export const header = (headers: Record<string, string | string[] | undefined>, name: string): string | undefined => {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};
