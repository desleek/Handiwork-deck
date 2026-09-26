import { timingSafeEqual } from 'node:crypto';
import { toMajor, toMinor } from '@handiwork/shared';
import {
  header,
  type NormalizedWebhookEvent,
  type PaymentProvider,
  WebhookSignatureError,
} from '../types';

const BASE_URL = 'https://api.flutterwave.com/v3';

const FLW_OPTION = { card: 'card', bank_transfer: 'banktransfer', ussd: 'ussd' } as const;

/**
 * Flutterwave Split Payments via subaccounts. Flutterwave's API takes amounts in
 * major units, so we convert at this boundary. `flat_subaccount` sends exactly
 * `transaction_charge` to the technician; the remainder is the platform's.
 */
export class FlutterwaveProvider implements PaymentProvider {
  readonly name = 'flutterwave' as const;

  constructor(
    private readonly secretKey: string,
    private readonly webhookHash: string | undefined,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${BASE_URL}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.secretKey}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as { status: string; message: string; data: T };
    if (!res.ok || json.status !== 'success') throw new Error(`Flutterwave ${path} failed: ${json.message}`);
    return json.data;
  }

  async onboardPayee(input: Parameters<PaymentProvider['onboardPayee']>[0]) {
    if (!input.bank) throw new Error('Flutterwave subaccounts require bank details');
    const data = await this.call<{ subaccount_id: string }>('POST', '/subaccounts', {
      account_bank: input.bank.bankCode,
      account_number: input.bank.accountNumber,
      business_name: input.fullName,
      business_email: input.email,
      country: input.country,
      split_type: 'percentage',
      split_value: 0, // overridden per transaction
      meta: [{ meta_name: 'userId', meta_value: input.userId }],
    });
    return { accountRef: data.subaccount_id };
  }

  async createSplitPayment(input: Parameters<PaymentProvider['createSplitPayment']>[0]) {
    const payeeShare = input.amount - input.platformFee;
    const data = await this.call<{ link: string }>('POST', '/payments', {
      tx_ref: input.reference,
      amount: toMajor(input.amount, input.currency),
      currency: input.currency,
      redirect_url: input.callbackUrl,
      customer: { email: input.customer.email, name: input.customer.name, phonenumber: input.customer.phone },
      customizations: { title: 'HANDIWORK-DECK', description: input.description },
      payment_options: input.methods.map((m) => FLW_OPTION[m]).join(','),
      ...(input.payeeAccountRef
        ? {
            subaccounts: [
              {
                id: input.payeeAccountRef,
                transaction_charge_type: 'flat_subaccount',
                transaction_charge: toMajor(payeeShare, input.currency),
              },
            ],
          }
        : {}),
      meta: input.metadata,
    });
    // Flutterwave's transaction id only exists after payment; tx_ref is our stable key.
    return { providerRef: input.reference, checkoutUrl: data.link, raw: data };
  }

  async payout(input: Parameters<PaymentProvider['payout']>[0]) {
    if (!input.payee.bankCode || !input.payee.accountNumber) throw new Error('Flutterwave payouts need bank details — re-run payout setup');
    const data = await this.call<{ id: number; status: string }>('POST', '/transfers', {
      account_bank: input.payee.bankCode,
      account_number: input.payee.accountNumber,
      amount: toMajor(input.amountMinor, input.currency),
      currency: input.currency,
      debit_currency: input.currency,
      reference: input.reference,
      narration: `HANDIWORK-DECK ${input.speed} payout`,
    });
    return { providerRef: String(data.id), status: data.status === 'SUCCESSFUL' ? ('sent' as const) : ('processing' as const) };
  }

  /** Flutterwave virtual account number (permanent accounts need the customer's BVN). */
  async createDedicatedAccount(input: Parameters<NonNullable<PaymentProvider['createDedicatedAccount']>>[0]) {
    const txRef = `va_${input.userId}`;
    const [first, ...rest] = input.name.split(/\s+/);
    const data = await this.call<{ account_number: string; bank_name: string; order_ref: string }>('POST', '/virtual-account-numbers', {
      email: input.email,
      tx_ref: txRef,
      is_permanent: Boolean(input.bvn),
      bvn: input.bvn,
      firstname: first,
      lastname: rest.join(' ') || first,
      phonenumber: input.phone,
      narration: `HANDIWORK ${input.name}`,
      currency: input.currency,
    });
    return { providerRef: txRef, accountNumber: data.account_number, accountName: input.name, bankName: data.bank_name };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NormalizedWebhookEvent> {
    const sig = header(headers, 'verif-hash');
    if (
      !sig ||
      !this.webhookHash ||
      sig.length !== this.webhookHash.length ||
      !timingSafeEqual(Buffer.from(sig), Buffer.from(this.webhookHash))
    ) {
      throw new WebhookSignatureError('flutterwave');
    }
    const payload = JSON.parse(rawBody.toString('utf8')) as {
      event: string;
      data: { id: number; tx_ref: string; status: string; amount: number; currency: string };
    };
    const { event, data } = payload;
    const id = `${event}:${data.id}:${data.status}`;
    if (event === 'charge.completed') {
      // Never trust webhook status alone for fulfilment in production: re-verify via
      // GET /transactions/:id/verify. We do that here before reporting success.
      if (data.status === 'successful') {
        const verified = await this.call<{ status: string; amount: number; currency: string; tx_ref: string }>(
          'GET',
          `/transactions/${data.id}/verify`,
        );
        if (verified.status === 'successful' && verified.tx_ref === data.tx_ref && data.tx_ref.startsWith('va_')) {
          // Transfer into a customer's dedicated virtual account.
          return { id, type: 'virtual_account.credited', accountRef: data.tx_ref, amount: toMinor(verified.amount, verified.currency), currency: verified.currency, raw: payload };
        }
        if (verified.status === 'successful' && verified.tx_ref === data.tx_ref) {
          return {
            id,
            type: 'payment.succeeded',
            providerRef: data.tx_ref,
            reference: data.tx_ref,
            amount: toMinor(verified.amount, verified.currency),
            currency: verified.currency,
            raw: payload,
          };
        }
      }
      return { id, type: 'payment.failed', providerRef: data.tx_ref, reference: data.tx_ref, raw: payload };
    }
    return { id, type: 'ignored', raw: payload };
  }

  async refund(input: Parameters<PaymentProvider['refund']>[0]) {
    // Refunds need Flutterwave's numeric transaction id; look it up by tx_ref.
    const txs = await this.call<{ id: number }[]>('GET', `/transactions?tx_ref=${encodeURIComponent(input.providerRef)}`);
    const tx = txs[0];
    if (!tx) throw new Error(`Flutterwave transaction ${input.providerRef} not found`);
    const data = await this.call<{ id: number }>('POST', `/transactions/${tx.id}/refund`, {
      amount: input.amount === undefined ? undefined : toMajor(input.amount, input.currency),
    });
    return { refundRef: String(data.id) };
  }
}
