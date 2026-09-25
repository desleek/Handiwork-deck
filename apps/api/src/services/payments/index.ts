import { env } from '../../config/env';
import { FlutterwaveProvider } from './providers/flutterwave';
import { MockProvider } from './providers/mock';
import { PaystackProvider } from './providers/paystack';
import { StripeProvider } from './providers/stripe';
import type { PaymentProvider, ProviderName } from './types';

export * from './types';

const cache = new Map<ProviderName, PaymentProvider>();

function build(name: ProviderName): PaymentProvider {
  const need = (value: string | undefined, key: string) => {
    if (!value) throw new Error(`${key} must be set to use the ${name} payment provider`);
    return value;
  };
  switch (name) {
    case 'stripe':
      return new StripeProvider(need(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'), env.STRIPE_WEBHOOK_SECRET);
    case 'paystack':
      return new PaystackProvider(need(env.PAYSTACK_SECRET_KEY, 'PAYSTACK_SECRET_KEY'));
    case 'flutterwave':
      return new FlutterwaveProvider(need(env.FLUTTERWAVE_SECRET_KEY, 'FLUTTERWAVE_SECRET_KEY'), env.FLUTTERWAVE_WEBHOOK_HASH);
    case 'mock':
      if (env.NODE_ENV === 'production') throw new Error('The mock payment provider is disabled in production');
      return new MockProvider();
  }
}

export function getProvider(name: ProviderName): PaymentProvider {
  let provider = cache.get(name);
  if (!provider) {
    provider = build(name);
    cache.set(name, provider);
  }
  return provider;
}

/** Parses `NGN:paystack,KES:flutterwave` into a lookup table. */
export function parseCurrencyRoutes(spec: string): Record<string, ProviderName> {
  const routes: Record<string, ProviderName> = {};
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [currency, provider] = part.split(':').map((s) => s.trim());
    if (!currency || !provider || !['stripe', 'paystack', 'flutterwave', 'mock'].includes(provider)) {
      throw new Error(`Invalid PAYMENT_CURRENCY_ROUTES entry: "${part}"`);
    }
    routes[currency.toUpperCase()] = provider as ProviderName;
  }
  return routes;
}

const routes = parseCurrencyRoutes(env.PAYMENT_CURRENCY_ROUTES);

/** Chooses the provider for a currency. In test/mock mode everything routes to mock. */
export function providerForCurrency(currency: string): ProviderName {
  if (env.PAYMENT_DEFAULT_PROVIDER === 'mock') return 'mock';
  return routes[currency.toUpperCase()] ?? env.PAYMENT_DEFAULT_PROVIDER;
}

export function isProviderName(v: string): v is ProviderName {
  return v === 'stripe' || v === 'paystack' || v === 'flutterwave' || v === 'mock';
}
