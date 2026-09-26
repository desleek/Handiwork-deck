import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  header,
  type NormalizedWebhookEvent,
  type PaymentProvider,
  WebhookSignatureError,
} from '../types';

const BASE_URL = 'https://api.paystack.co';
const RECIPIENT_TYPE: Record<string, string> = { NGN: 'nuban', GHS: 'ghipss', KES: 'kepss', ZAR: 'basa' };

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
    // Payouts use Paystack Transfers, which need a transfer recipient.
    const currency = input.currency ?? 'NGN';
    const recipient = await this.call<{ recipient_code: string }>('POST', '/transferrecipient', {
      type: RECIPIENT_TYPE[currency] ?? 'nuban',
      name: input.fullName,
      account_number: input.bank.accountNumber,
      bank_code: input.bank.bankCode,
      currency,
    });
    return { accountRef: data.subaccount_code, recipientRef: recipient.recipient_code };
  }

  /** Paystack Dedicated Virtual Account: customer record + a dedicated NUBAN. */
  async createDedicatedAccount(input: Parameters<NonNullable<PaymentProvider['createDedicatedAccount']>>[0]) {
    const [first, ...rest] = input.name.split(/\s+/);
    const customer = await this.call<{ customer_code: string }>('POST', '/customer', {
      email: input.email,
      first_name: first,
      last_name: rest.join(' ') || first,
      phone: input.phone,
      metadata: { userId: input.userId },
    });
    const acct = await this.call<{ account_number: string; account_name: string; bank: { name: string } }>('POST', '/dedicated_account', {
      customer: customer.customer_code,
      preferred_bank: 'wema-bank',
    });
    return { providerRef: customer.customer_code, accountNumber: acct.account_number, accountName: acct.account_name, bankName: acct.bank?.name ?? null };
  }

  async payout(input: Parameters<PaymentProvider['payout']>[0]) {
    if (!input.payee.recipientRef) throw new Error('Paystack payouts need a transfer recipient — re-run payout setup');
    const data = await this.call<{ transfer_code: string; status: string }>('POST', '/transfer', {
      source: 'balance',
      amount: input.amountMinor,
      currency: input.currency,
      recipient: input.payee.recipientRef,
      reference: input.reference,
      reason: `HANDIWORK-DECK ${input.speed} payout`,
    });
    return { providerRef: data.transfer_code, status: data.status === 'success' ? ('sent' as const) : ('processing' as const) };
  }

  async createSplitPayment(input: Parameters<PaymentProvider['createSplitPayment']>[0]) {
    if (!input.customer.email) throw new Error('Paystack requires a customer email');
    const data = await this.call<{ authorization_url: string; reference: string }>('POST', '/transaction/initialize', {
      email: input.customer.email,
      amount: input.amount,
      currency: input.currency,
      reference: input.reference,
      channels: input.methods,
      ...(input.payeeAccountRef
        ? { subaccount: input.payeeAccountRef, transaction_charge: input.platformFee, bearer: 'subaccount' }
        : {}),
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
      data: {
        id: number;
        reference?: string;
        amount?: number;
        currency?: string;
        transaction_reference?: string;
        channel?: string;
        customer?: { customer_code?: string };
      };
    };
    const { event, data } = payload;
    const id = `${event}:${data.id}`;
    // Transfers into a customer's dedicated virtual account (per-customer bank transfer).
    if (event === 'charge.success' && data.channel === 'dedicated_nuban') {
      return { id, type: 'virtual_account.credited', providerRef: data.reference, accountRef: data.customer?.customer_code, amount: data.amount, currency: data.currency, raw: payload };
    }
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
