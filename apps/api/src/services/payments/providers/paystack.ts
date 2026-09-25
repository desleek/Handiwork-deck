import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  header,
  type NormalizedWebhookEvent,
  type PaymentProvider,
  WebhookSignatureError,
} from '../types';

const BASE_URL = 'https://api.paystack.co';

/**
 * Paystack Split Payments via subaccounts. `transaction_charge` is a flat amount
 * (in minor units) that goes to the main (platform) account; the rest settles to
 * the technician's subaccount. `bearer: 'subaccount'` makes the technician's share
 * absorb Paystack's processing fee.
 */
export class PaystackProvider implements PaymentProvider {
  readonly name = 'paystack' as const;

  constructor(
    private readonly secretKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { status: boolean; message: string; data: T };
    if (!res.ok || !json.status) throw new Error(`Paystack ${path} failed: ${json.message}`);
    return json.data;
  }

  async onboardPayee(input: Parameters<PaymentProvider['onboardPayee']>[0]) {
    if (!input.bank) throw new Error('Paystack subaccounts require bank details');
    const data = await this.call<{ subaccount_code: string }>('POST', '/subaccount', {
      business_name: input.fullName,
      settlement_bank: input.bank.bankCode,
      account_number: input.bank.accountNumber,
      // Required by the API; overridden per transaction by transaction_charge.
      percentage_charge: 0,
      primary_contact_email: input.email,
      metadata: { userId: input.userId },
    });
    return { accountRef: data.subaccount_code };
  }

  async createSplitPayment(input: Parameters<PaymentProvider['createSplitPayment']>[0]) {
    if (!input.customer.email) throw new Error('Paystack requires a customer email');
    const data = await this.call<{ authorization_url: string; reference: string }>('POST', '/transaction/initialize', {
      email: input.customer.email,
      amount: input.amount,
      currency: input.currency,
      reference: input.reference,
      subaccount: input.payeeAccountRef,
      transaction_charge: input.platformFee,
      bearer: 'subaccount',
      callback_url: input.callbackUrl,
      metadata: input.metadata,
    });
    return { providerRef: data.reference, checkoutUrl: data.authorization_url, raw: data };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NormalizedWebhookEvent> {
    const sig = header(headers, 'x-paystack-signature');
    const expected = createHmac('sha512', this.secretKey).update(rawBody).digest('hex');
    if (!sig || sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
      throw new WebhookSignatureError('paystack');
    }
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      data: { id: number; reference?: string; amount?: number; currency?: string; transaction_reference?: string };
    };
    const { event, data } = payload;
    const id = `${event}:${data.id}`;
    switch (event) {
      case 'charge.success':
        return { id, type: 'payment.succeeded', providerRef: data.reference, reference: data.reference, amount: data.amount, currency: data.currency, raw: payload };
      case 'charge.failed':
        return { id, type: 'payment.failed', providerRef: data.reference, reference: data.reference, raw: payload };
      case 'refund.processed':
        return { id, type: 'refund.succeeded', providerRef: data.transaction_reference, amount: data.amount, currency: data.currency, raw: payload };
      default:
        return { id, type: 'ignored', raw: payload };
    }
  }

  async refund(input: Parameters<PaymentProvider['refund']>[0]) {
    const data = await this.call<{ id: number }>('POST', '/refund', { transaction: input.providerRef, amount: input.amount });
    return { refundRef: String(data.id) };
  }
}
