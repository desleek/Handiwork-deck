import type { PaymentMethod } from '@handiwork/shared';
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

type GatewayMethod = Exclude<PaymentMethod, 'wallet'>;

/** What each gateway can take, per currency. USSD is a Nigerian rail. */
const CAPABILITIES: Record<ProviderName, { currencies: string[] | '*'; methods: (currency: string) => GatewayMethod[] }> = {
  stripe: { currencies: '*', methods: () => ['card'] },
  paystack: {
    currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'],
    methods: (c) => (c === 'NGN' ? ['card', 'bank_transfer', 'ussd'] : c === 'GHS' || c === 'KES' ? ['card', 'bank_transfer'] : ['card']),
  },
  flutterwave: {
    currencies: '*',
    methods: (c) => (c === 'NGN' ? ['card', 'bank_transfer', 'ussd'] : ['card', 'bank_transfer']),
  },
  mock: { currencies: '*', methods: () => ['card', 'bank_transfer', 'ussd'] },
};

function isConfigured(name: ProviderName): boolean {
  switch (name) {
    case 'stripe':
      return !!env.STRIPE_SECRET_KEY;
    case 'paystack':
      return !!env.PAYSTACK_SECRET_KEY;
    case 'flutterwave':
      return !!env.FLUTTERWAVE_SECRET_KEY;
    case 'mock':
      return env.PAYMENT_DEFAULT_PROVIDER === 'mock';
  }
}

/** Gateways usable for `currency` in this deployment (mock mode offers only the mock gateway). */
export function availableGateways(currency: string): { provider: ProviderName; methods: GatewayMethod[] }[] {
  const names: ProviderName[] = env.PAYMENT_DEFAULT_PROVIDER === 'mock' ? ['mock'] : ['paystack', 'flutterwave', 'stripe'];
  return names
    .filter((n) => isConfigured(n))
    .filter((n) => CAPABILITIES[n].currencies === '*' || (CAPABILITIES[n].currencies as string[]).includes(currency.toUpperCase()))
    .map((n) => ({ provider: n, methods: CAPABILITIES[n].methods(currency.toUpperCase()) }));
}

/**
 * Picks the gateway for a payment. An explicit choice must support the method;
 * otherwise prefer the technician's payout gateway (enables split-at-source),
 * then the currency route, then any gateway that supports the method.
 */
export function chooseGateway(currency: string, method: GatewayMethod, opts: { requested?: ProviderName; preferred?: ProviderName | null }): ProviderName {
  const options = availableGateways(currency).filter((g) => g.methods.includes(method));
  if (!options.length) throw new Error(`No payment gateway supports ${method} in ${currency}`);
  const has = (n?: ProviderName | null) => !!n && options.some((o) => o.provider === n);
  if (opts.requested) {
    if (!has(opts.requested)) throw new Error(`${opts.requested} cannot take ${method} payments in ${currency}`);
    return opts.requested;
  }
  if (has(opts.preferred)) return opts.preferred!;
  const routed = providerForCurrency(currency);
  if (has(routed)) return routed;
  return options[0]!.provider;
}
