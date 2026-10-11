import { flutterwave } from './flutterwave.ts';
import { mock } from './mock.ts';
import { paystack } from './paystack.ts';
import { stripe } from './stripe.ts';
import { PaymentError, type Channel, type CheckoutRequest, type CheckoutResult, type PaymentProvider } from './types.ts';

export const PROVIDERS: Record<string, PaymentProvider> = { paystack, flutterwave, stripe, mock };

export function getProvider(name: string): PaymentProvider {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`Unknown payment provider ${name}`);
  return p;
}

/** Providers able to serve this channel+currency, in admin-configured priority order. */
export function candidates(priority: string[], channel: Channel, currency: string): PaymentProvider[] {
  const ordered = [...priority, 'mock'].map((n) => PROVIDERS[n]).filter(Boolean);
  return ordered.filter((p) => p.isConfigured() && p.channels.includes(channel) && p.currencies.includes(currency));
}

/**
 * Try providers in priority order, falling back on retryable failures (outage, 5xx, timeout).
 * Non-retryable errors (e.g. invalid request) stop immediately.
 */
export async function checkoutWithFallback(
  priority: string[],
  req: CheckoutRequest,
): Promise<{ provider: PaymentProvider; result: CheckoutResult }> {
  const list = candidates(priority, req.channel, req.currency);
  if (list.length === 0) throw new PaymentError('router', `No configured provider supports ${req.channel} in ${req.currency}`, false);
  let lastErr: unknown;
  for (const provider of list) {
    try {
      const result = await provider.createCheckout(req);
      return { provider, result };
    } catch (err) {
      lastErr = err;
      if (err instanceof PaymentError && !err.retryable) throw err;
    }
  }
  throw lastErr;
}
