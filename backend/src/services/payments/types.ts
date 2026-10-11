/**
 * Provider-agnostic payment abstraction (Section 11).
 * Every gateway implements this interface; the router picks one by admin-configured priority
 * with fallback. All channels feed the same flow: collect → hold in escrow (platform balance)
 * → itemized capture → split to technician wallet + platform revenue.
 * New banks/partners are added by writing one more adapter — nothing else changes.
 */

export type Channel = 'card' | 'bank_transfer' | 'ussd';

export interface CheckoutRequest {
  reference: string; // our payment id; idempotency key at the provider
  amountMinor: number;
  currency: string;
  channel: Channel;
  customer: { id: string; email: string; name: string; phone?: string | null };
  description: string;
  callbackUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface CheckoutResult {
  providerRef: string;
  /** Hosted checkout / 3DS page (card). */
  authorizationUrl?: string;
  /** Pay-by-transfer details (bank_transfer). */
  virtualAccount?: { bankName: string; accountNumber: string; accountName: string; expiresAt?: string };
  /** USSD dial string. */
  ussd?: { code: string; bank?: string };
  /** Stripe-style client secret for in-app payment sheets. */
  clientSecret?: string;
}

export interface VerifyResult {
  status: 'succeeded' | 'pending' | 'failed';
  amountMinor: number;
  currency: string;
  feeMinor?: number;
  raw?: unknown;
}

export interface TransferRequest {
  reference: string;
  amountMinor: number;
  currency: string;
  recipientCode: string; // provider-tokenized bank account
  reason: string;
  speed: 'standard' | 'instant';
}

export interface WebhookEvent {
  eventId: string;
  type: 'charge.succeeded' | 'charge.failed' | 'transfer.succeeded' | 'transfer.failed' | 'other';
  providerRef: string;
  /** Our payment / withdrawal id echoed back by the provider. */
  reference?: string;
  amountMinor?: number;
  raw: unknown;
}

export interface PaymentProvider {
  readonly name: string;
  readonly channels: Channel[];
  readonly currencies: string[];
  isConfigured(): boolean;
  createCheckout(req: CheckoutRequest): Promise<CheckoutResult>;
  verify(providerRef: string): Promise<VerifyResult>;
  refund(providerRef: string, amountMinor: number): Promise<{ ok: boolean; raw?: unknown }>;
  createTransferRecipient?(p: { accountNumber: string; bankCode: string; name: string }): Promise<{ recipientCode: string; accountName: string }>;
  transfer?(req: TransferRequest): Promise<{ providerRef: string; status: 'pending' | 'succeeded' | 'failed' }>;
  /** Verify the signature and normalise the event. Return null if the signature is invalid. */
  parseWebhook(headers: Record<string, string | string[] | undefined>, rawBody: Buffer): WebhookEvent | null;
}

export class PaymentError extends Error {
  readonly provider: string;
  readonly retryable: boolean;
  constructor(provider: string, message: string, retryable = true) {
    super(`[${provider}] ${message}`);
    this.provider = provider;
    this.retryable = retryable;
  }
}
