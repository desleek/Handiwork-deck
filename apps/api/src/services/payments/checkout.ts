import { env } from '../../config/env';
import { query } from '../../db/pool';
import { badRequest, HttpError } from '../../lib/errors';
import { logger } from '../../lib/logger';
import type { AppUser } from '../../middleware/auth';
import { type GatewayMethod, gatewayCandidates, getProvider } from './index';
import type { ProviderName } from './types';

/** Resolves the ordered gateways for a payment, turning routing errors into 400s. */
export async function candidatesOrReject(currency: string, method: GatewayMethod, requested?: ProviderName): Promise<ProviderName[]> {
  try {
    return await gatewayCandidates(currency, method, requested);
  } catch (err) {
    throw badRequest((err as Error).message);
  }
}

/**
 * Opens a hosted checkout for an existing `payments` row. Gateways are tried in
 * the admin-configured priority order; if one errors (outage, rejected currency)
 * the next is tried and the row is re-pointed at whichever succeeded.
 */
export async function startCheckout(
  paymentId: string,
  candidates: ProviderName[],
  p: {
    amount: number;
    platformFee: number;
    currency: string;
    method: GatewayMethod;
    customer: AppUser;
    description: string;
    metadata: Record<string, string>;
  },
): Promise<{ provider: ProviderName; checkoutUrl: string | null }> {
  let lastError: unknown;
  for (const provider of candidates) {
    try {
      const result = await getProvider(provider).createSplitPayment({
        reference: paymentId,
        amount: p.amount,
        platformFee: p.platformFee,
        currency: p.currency,
        methods: [p.method],
        customer: { email: p.customer.email ?? undefined, name: p.customer.full_name, phone: p.customer.phone_e164 ?? undefined },
        description: p.description,
        callbackUrl: `${env.PUBLIC_BASE_URL}/v1/payments/return`,
        metadata: p.metadata,
      });
      await query('UPDATE payments SET provider = $2, provider_ref = $3, checkout_url = $4 WHERE id = $1', [
        paymentId,
        provider,
        result.providerRef,
        result.checkoutUrl ?? null,
      ]);
      return { provider, checkoutUrl: result.checkoutUrl ?? null };
    } catch (err) {
      lastError = err;
      logger.warn({ err, provider, paymentId }, 'gateway checkout failed; trying next');
    }
  }
  await query(`UPDATE payments SET status = 'failed' WHERE id = $1`, [paymentId]);
  throw new HttpError(502, `Payment gateway unavailable: ${(lastError as Error)?.message ?? 'no gateway'}`, 'gateway_unavailable');
}
