import Stripe from 'stripe';
import {
  header,
  type NormalizedWebhookEvent,
  type PaymentProvider,
  WebhookSignatureError,
} from '../types';

/**
 * Stripe Connect using Express accounts and destination charges: the customer is
 * charged on the platform, `application_fee_amount` stays with us and the rest is
 * transferred to the technician's connected account.
 *
 * `providerRef` starts as the Checkout Session id and is replaced by the
 * PaymentIntent id when `payment_intent.succeeded` arrives (refunds need it).
 */
export class StripeProvider implements PaymentProvider {
  readonly name = 'stripe' as const;
  private readonly stripe: Stripe;

  constructor(
    secretKey: string,
    private readonly webhookSecret: string | undefined,
  ) {
    this.stripe = new Stripe(secretKey);
  }

  async onboardPayee(input: Parameters<PaymentProvider['onboardPayee']>[0]) {
    const account = await this.stripe.accounts.create({
      type: 'express',
      country: input.country,
      email: input.email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      metadata: { userId: input.userId },
    });
    const returnUrl = input.returnUrl ?? 'https://handiwork-deck.app/onboarding/done';
    const link = await this.stripe.accountLinks.create({
      account: account.id,
      type: 'account_onboarding',
      return_url: returnUrl,
      refresh_url: returnUrl,
    });
    return { accountRef: account.id, onboardingUrl: link.url };
  }

  /**
   * Hosted Checkout Session so the app can use the same WebView/browser flow as
   * Paystack and Flutterwave. The PaymentIntent carries our reference in its
   * metadata, which is what the webhook matches on.
   */
  async createSplitPayment(input: Parameters<PaymentProvider['createSplitPayment']>[0]) {
    const returnUrl = input.callbackUrl ?? 'https://handiwork-deck.app/payments/return';
    const session = await this.stripe.checkout.sessions.create(
      {
        mode: 'payment',
        customer_email: input.customer.email,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: input.currency.toLowerCase(),
              unit_amount: input.amount,
              product_data: { name: input.description },
            },
          },
        ],
        payment_intent_data: {
          application_fee_amount: input.platformFee,
          transfer_data: { destination: input.payeeAccountRef },
          metadata: { ...input.metadata, reference: input.reference },
        },
        metadata: { ...input.metadata, reference: input.reference },
        success_url: `${returnUrl}?status=success`,
        cancel_url: `${returnUrl}?status=cancelled`,
      },
      { idempotencyKey: input.reference },
    );
    return { providerRef: session.id, checkoutUrl: session.url ?? undefined, raw: session };
  }

  async parseWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): Promise<NormalizedWebhookEvent> {
    const sig = header(headers, 'stripe-signature');
    if (!sig || !this.webhookSecret) throw new WebhookSignatureError('stripe');
    let event: Stripe.Event;
    try {
      event = this.stripe.webhooks.constructEvent(rawBody, sig, this.webhookSecret);
    } catch {
      throw new WebhookSignatureError('stripe');
    }
    switch (event.type) {
      case 'payment_intent.succeeded':
      case 'payment_intent.payment_failed': {
        const pi = event.data.object;
        return {
          id: event.id,
          type: event.type === 'payment_intent.succeeded' ? 'payment.succeeded' : 'payment.failed',
          providerRef: pi.id,
          reference: pi.metadata?.reference,
          amount: pi.amount_received || pi.amount,
          currency: pi.currency.toUpperCase(),
          raw: event,
        };
      }
      case 'charge.refunded': {
        const charge = event.data.object;
        return {
          id: event.id,
          type: 'refund.succeeded',
          providerRef: typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id,
          amount: charge.amount_refunded,
          amountIsCumulative: true,
          currency: charge.currency.toUpperCase(),
          raw: event,
        };
      }
      default:
        return { id: event.id, type: 'ignored', raw: event };
    }
  }

  async refund(input: Parameters<PaymentProvider['refund']>[0]) {
    const refund = await this.stripe.refunds.create({
      payment_intent: input.providerRef,
      amount: input.amount,
      // Pull the money back from the technician and return our fee proportionally.
      reverse_transfer: true,
      refund_application_fee: true,
    });
    return { refundRef: refund.id };
  }
}
