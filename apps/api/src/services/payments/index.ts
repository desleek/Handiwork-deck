import type { PaymentMethod } from '@handiwork/shared';
import { env } from '../../config/env';
import { getSetting } from '../settings';
import { FlutterwaveProvider } from './providers/flutterwave';
import { MockProvider } from './providers/mock';
import { PaystackProvider } from './providers/paystack';
import { StripeProvider } from './providers/stripe';
import type { PaymentProvider, ProviderName } from './types';

export * from './types';

export type GatewayMethod = Exclude<PaymentMethod, 'wallet'>;

/**
 * Section 11: provider-agnostic payment layer. Every gateway (bank, card processor,
 * partner) registers here with what it can do; the rest of the app only talks to
 * the PaymentProvider interface. To plug in a new partner: implement
 * PaymentProvider, call registerProvider(), and add its name to the
 * `payment_provider` enum in a migration.
 */
export interface ProviderRegistration {
  name: ProviderName;
  create(): PaymentProvider;
  configured(): boolean;
  currencies: string[] | '*';
  methods(currency: string): GatewayMethod[];
  /** Supports per-customer dedicated virtual accounts. */
  dedicatedAccounts: boolean;
}

const REGISTRY = new Map<ProviderName, ProviderRegistration>();
const instances = new Map<ProviderName, PaymentProvider>();

export function registerProvider(reg: ProviderRegistration) {
  REGISTRY.set(reg.name, reg);
  instances.delete(reg.name);
}

const need = (value: string | undefined, key: string) => {
  if (!value) throw new Error(`${key} must be set to use this payment provider`);
  return value;
};

registerProvider({
  name: 'paystack',
  create: () => new PaystackProvider(need(env.PAYSTACK_SECRET_KEY, 'PAYSTACK_SECRET_KEY')),
  configured: () => !!env.PAYSTACK_SECRET_KEY,
  currencies: ['NGN', 'GHS', 'ZAR', 'KES', 'USD'],
  methods: (c) => (c === 'NGN' ? ['card', 'bank_transfer', 'ussd'] : c === 'GHS' || c === 'KES' ? ['card', 'bank_transfer'] : ['card']),
  dedicatedAccounts: true,
});
registerProvider({
  name: 'flutterwave',
  create: () => new FlutterwaveProvider(need(env.FLUTTERWAVE_SECRET_KEY, 'FLUTTERWAVE_SECRET_KEY'), env.FLUTTERWAVE_WEBHOOK_HASH),
  configured: () => !!env.FLUTTERWAVE_SECRET_KEY,
  currencies: '*',
  methods: (c) => (c === 'NGN' ? ['card', 'bank_transfer', 'ussd'] : ['card', 'bank_transfer']),
  dedicatedAccounts: true,
});
registerProvider({
  name: 'stripe',
  create: () => new StripeProvider(need(env.STRIPE_SECRET_KEY, 'STRIPE_SECRET_KEY'), env.STRIPE_WEBHOOK_SECRET),
  configured: () => !!env.STRIPE_SECRET_KEY,
  currencies: '*',
  methods: () => ['card'],
  dedicatedAccounts: false,
});
registerProvider({
  name: 'mock',
  create: () => {
    if (env.NODE_ENV === 'production') throw new Error('The mock payment provider is disabled in production');
    return new MockProvider();
  },
  configured: () => env.PAYMENT_DEFAULT_PROVIDER === 'mock',
  currencies: '*',
  methods: () => ['card', 'bank_transfer', 'ussd'],
  dedicatedAccounts: true,
});

export function getProvider(name: ProviderName): PaymentProvider {
  let provider = instances.get(name);
  if (!provider) {
    const reg = REGISTRY.get(name);
    if (!reg) throw new Error(`Unknown payment provider ${name}`);
    provider = reg.create();
    instances.set(name, provider);
  }
  return provider;
}

export function isProviderName(v: string): v is ProviderName {
  return REGISTRY.has(v as ProviderName);
}

/**
 * Gateways usable for a currency, in the admin-configured priority order
 * (`payment_routing`), skipping any that are disabled, unconfigured (no keys) or
 * don't serve the currency. In development/test the mock gateway is appended.
 */
export async function gatewaysFor(currency: string, method?: GatewayMethod): Promise<{ provider: ProviderName; methods: GatewayMethod[] }[]> {
  const cur = currency.toUpperCase();
  const routing = await getSetting('payment_routing');
  const order = (routing.priority[cur] ?? routing.priority.default ?? []).filter((g) => routing.enabledGateways.includes(g));
  if (env.PAYMENT_DEFAULT_PROVIDER === 'mock') order.push('mock');
  return [...new Set(order)]
    .map((n) => REGISTRY.get(n as ProviderName))
    .filter((r): r is ProviderRegistration => !!r && r.configured())
    .filter((r) => r.currencies === '*' || r.currencies.includes(cur))
    .map((r) => ({ provider: r.name, methods: r.methods(cur) }))
    .filter((g) => !method || g.methods.includes(method));
}

export function getRegistration(name: ProviderName): ProviderRegistration | undefined {
  return REGISTRY.get(name);
}

/** Kept for callers that want the flat list. */
export const availableGateways = gatewaysFor;

/**
 * Candidate gateways for a payment, best first: an explicit choice, else the
 * routing priority. With fallback on, later candidates are tried if one errors.
 */
export async function gatewayCandidates(currency: string, method: GatewayMethod, requested?: ProviderName): Promise<ProviderName[]> {
  const options = (await gatewaysFor(currency, method)).map((g) => g.provider);
  if (!options.length) throw new Error(`No payment gateway supports ${method} in ${currency}`);
  if (requested) {
    if (!options.includes(requested)) throw new Error(`${requested} cannot take ${method} payments in ${currency}`);
    return [requested];
  }
  const { fallbackOnError } = await getSetting('payment_routing');
  return fallbackOnError ? options : options.slice(0, 1);
}

/** The top-priority gateway for a currency (e.g. where technicians onboard for payouts). */
export async function providerForCurrency(currency: string): Promise<ProviderName> {
  const [first] = await gatewaysFor(currency);
  if (!first) throw new Error(`No payment gateway configured for ${currency}`);
  return first.provider;
}

export async function dedicatedAccountGateway(currency: string): Promise<ProviderName | null> {
  for (const g of await gatewaysFor(currency)) if (REGISTRY.get(g.provider)?.dedicatedAccounts) return g.provider;
  return null;
}
